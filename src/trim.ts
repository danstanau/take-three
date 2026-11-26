export type RedactionMask = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  mode: "cover" | "blur";
};

export function drawRedactions(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  masks: RedactionMask[],
) {
  for (const mask of masks) {
    const x = mask.x * video.videoWidth;
    const y = mask.y * video.videoHeight;
    const width = mask.width * video.videoWidth;
    const height = mask.height * video.videoHeight;
    if (mask.mode === "cover") {
      context.fillStyle = "#101713";
      context.fillRect(x, y, width, height);
    } else {
      context.save();
      context.beginPath();
      context.rect(x, y, width, height);
      context.clip();
      context.filter = `blur(${Math.max(24, Math.round(Math.min(video.videoWidth, video.videoHeight) * 0.035))}px)`;
      context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
      context.restore();
    }
  }
}

export async function renderTrimmedWebM(
  video: HTMLVideoElement,
  start: number,
  end: number,
  onProgress?: (progress: number) => void,
  redactions: RedactionMask[] = [],
): Promise<Blob> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error("Choose a valid start and end time.");
  }
  const captureVideo = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  const captureStream = captureVideo.captureStream ?? captureVideo.mozCaptureStream;
  if (!captureStream) {
    throw new Error("This browser cannot trim video in place. Try a browser with media capture support.");
  }

  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    .find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error("This browser cannot export a trimmed WebM recording.");

  const sourceStream = captureStream.call(video);
  if (!sourceStream.getVideoTracks().length) {
    sourceStream.getTracks().forEach((track) => track.stop());
    throw new Error("The recording video could not be captured for trimming.");
  }

  let canvasStream: MediaStream | undefined;
  let renderContext: CanvasRenderingContext2D | undefined;
  let outputStream = sourceStream;
  if (redactions.length) {
    if (!video.videoWidth || !video.videoHeight) {
      sourceStream.getTracks().forEach((track) => track.stop());
      throw new Error("Wait for the video preview to load before adding redactions.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    renderContext = canvas.getContext("2d", { alpha: false }) ?? undefined;
    if (!renderContext || typeof canvas.captureStream !== "function") {
      sourceStream.getTracks().forEach((track) => track.stop());
      throw new Error("This browser cannot render redaction masks.");
    }
    canvasStream = canvas.captureStream(30);
    outputStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...sourceStream.getAudioTracks(),
    ]);
  }

  if (!outputStream.getVideoTracks().length) {
    sourceStream.getTracks().forEach((track) => track.stop());
    canvasStream?.getTracks().forEach((track) => track.stop());
    throw new Error("The recording video could not be captured for editing.");
  }

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(outputStream, {
      mimeType,
      videoBitsPerSecond: Math.min(25_000_000, Math.max(2_500_000, video.videoWidth * video.videoHeight * 4)),
      audioBitsPerSecond: 128_000,
    });
  } catch (error) {
    sourceStream.getTracks().forEach((track) => track.stop());
    canvasStream?.getTracks().forEach((track) => track.stop());
    throw new Error("The browser could not start a local video export.", { cause: error });
  }
  const chunks: Blob[] = [];
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let recordingError: Error | undefined;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener("error", () => {
    recordingError = new Error("The browser could not encode this trimmed clip.");
  });
  recorder.addEventListener("stop", resolveStopped, { once: true });

  const originalTime = video.currentTime;
  let frame = 0;
  let started = false;
  const drawRedactedFrame = () => {
    if (!renderContext) return;
    try {
      renderContext.clearRect(0, 0, video.videoWidth, video.videoHeight);
      renderContext.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
      drawRedactions(renderContext, video, redactions);
    } catch (error) {
      recordingError = new Error("The browser could not render the redaction masks.", { cause: error });
    }
  };
  try {
    video.pause();
    video.currentTime = start;
    const playback = video.play();
    recorder.start(250);
    started = true;
    await playback;
    await new Promise<void>((resolve, reject) => {
      const checkProgress = () => {
        drawRedactedFrame();
        if (recordingError) {
          reject(recordingError);
          return;
        }
        if (video.currentTime >= end) {
          video.pause();
          resolve();
          return;
        }
        if (video.ended || video.paused) {
          reject(new Error("Playback stopped before the selected end time."));
          return;
        }
        onProgress?.(Math.min(1, (video.currentTime - start) / (end - start)));
        frame = requestAnimationFrame(checkProgress);
      };
      frame = requestAnimationFrame(checkProgress);
    });
    recorder.stop();
    await stopped;
    const result = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    if (!result.size) throw new Error("The trimmed clip is empty.");
    onProgress?.(1);
    return result;
  } catch (error) {
    if (started && recorder.state !== "inactive") recorder.stop();
    throw error;
  } finally {
    cancelAnimationFrame(frame);
    video.pause();
    if (Number.isFinite(originalTime)) video.currentTime = originalTime;
    sourceStream.getTracks().forEach((track) => track.stop());
    canvasStream?.getTracks().forEach((track) => track.stop());
  }
}
