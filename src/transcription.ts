import type {
  AutomaticSpeechRecognitionOutput,
  ProgressCallback,
  ProgressInfo,
} from "@huggingface/transformers";

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

type Transcriber = (
  audio: Float32Array,
  options: { chunk_length_s: number; stride_length_s: number; return_timestamps: true; task: string; max_new_tokens: number },
) => Promise<AutomaticSpeechRecognitionOutput>;

let transcriberPromise: Promise<Transcriber> | undefined;

function getTranscriber(onProgress?: ProgressCallback): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = import("@huggingface/transformers")
      .then(({ pipeline }) =>
        pipeline("automatic-speech-recognition", "onnx-community/whisper-small", {
          dtype: "q8",
          progress_callback: onProgress,
        }),
      )
      .catch((error: unknown) => {
        transcriberPromise = undefined;
        throw error;
      });
  }
  return transcriberPromise;
}

export function toTranscriptSegments(
  output: { text: string; chunks?: Array<{ text: string; timestamp: [number | null, number | null] }> },
  duration?: number,
): TranscriptSegment[] {
  const chunks = output.chunks ?? [];
  const audioEnd = duration !== undefined && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
  return chunks.flatMap((chunk, index) => {
    const text = chunk.text.trim();
    const [start, end] = chunk.timestamp;
    if (!text || typeof start !== "number" || !Number.isFinite(start) || (audioEnd !== undefined && start > audioEnd)) return [];
    const safeStart = Math.max(0, start);
    let safeEnd = end;
    if (typeof safeEnd !== "number" || !Number.isFinite(safeEnd)) {
      safeEnd = chunks.slice(index + 1).map((next) => next.timestamp[0])
        .find((time) => typeof time === "number" && Number.isFinite(time) && time >= safeStart) ?? audioEnd ?? safeStart;
    }
    return [{ start: safeStart, end: Math.max(safeStart, audioEnd === undefined ? safeEnd : Math.min(safeEnd, audioEnd)), text }];
  });
}

export function searchTranscript(segments: TranscriptSegment[], query: string): TranscriptSegment[] {
  const search = query.trim().toLocaleLowerCase();
  return segments.filter((segment) => segment.text.toLocaleLowerCase().includes(search));
}

async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    try {
      decoded = await context.decodeAudioData(await blob.arrayBuffer());
    } catch (error) {
      throw new Error("Could not read audio from this recording. Make sure it includes an audio track.", { cause: error });
    }
  } finally {
    await context.close();
  }

  const sampleRate = 16_000;
  const frameCount = Math.ceil(decoded.duration * sampleRate);
  const offline = new OfflineAudioContext(1, frameCount, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const resampled = await offline.startRendering();
  return resampled.getChannelData(0);
}

export async function transcribeRecording(
  blob: Blob,
  onProgress?: ProgressCallback,
  onModelReady?: () => void,
): Promise<TranscriptSegment[]> {
  const audio = await decodeToMono16k(blob);
  if (!audio.length) throw new Error("This recording does not contain audio to transcribe.");
  if (audio.every((sample) => sample === 0)) return [];

  const transcriber = await getTranscriber(onProgress);
  onModelReady?.();
  const output = await transcriber(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    task: "transcribe",
    // Keep generation within each overlapping window rather than re-seeking through it.
    max_new_tokens: 448,
  });
  return toTranscriptSegments(output, audio.length / 16_000);
}

export function getModelProgress(progress: ProgressInfo): string | undefined {
  if (progress.status === "progress_total") {
    return `Downloading speech model · ${Math.round(progress.progress)}%`;
  }
  return undefined;
}
