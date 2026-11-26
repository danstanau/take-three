import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Cloud,
  AudioLines,
  Download,
  EyeOff,
  ExternalLink,
  LoaderCircle,
  Mic,
  Monitor,
  MoreHorizontal,
  PictureInPicture2,
  Play,
  Scissors,
  Settings,
  Search,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  CloudHttpError,
  connectGoogle,
  connectMicrosoft,
  uploadGoogle,
  uploadSharePoint,
  type Provider,
  type UploadResult,
} from "./cloud";
import {
  getModelProgress,
  searchTranscript,
  transcribeRecording,
  type TranscriptSegment,
} from "./transcription";
import { createLibraryBackup } from "./backup";
import { renderTrimmedWebM, type RedactionMask } from "./trim";

type Recording = {
  id: string;
  title: string;
  createdAt: number;
  duration: number;
  blob: Blob;
  thumbnail?: string;
  uploads?: UploadResult[];
  transcript?: TranscriptSegment[];
};

const DB_NAME = "take-three";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("recordings", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getRecordings(): Promise<Recording[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("recordings").objectStore("recordings").getAll();
    request.onsuccess = () =>
      resolve((request.result as Recording[]).sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

async function saveRecording(recording: Recording) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const request = db
      .transaction("recordings", "readwrite")
      .objectStore("recordings")
      .put(recording);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function deleteRecording(id: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction("recordings", "readwrite").objectStore("recordings").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function formatTrimTime(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${formatTime(safe)}.${Math.floor((safe % 1) * 10)}`;
}

function App() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [liveUrl, setLiveUrl] = useState<string>();
  const [isRecording, setIsRecording] = useState(false);
  const [countdown, setCountdown] = useState<number>();
  const [elapsed, setElapsed] = useState(0);
  const [micEnabled, setMicEnabled] = useState(true);
  const [draftTitle, setDraftTitle] = useState("");
  const [previewMode, setPreviewMode] = useState<"idle" | "recording" | "review">("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string>();
  const [tokens, setTokens] = useState<Partial<Record<Provider, string>>>({});
  const [connecting, setConnecting] = useState<Provider>();
  const [siteUrl, setSiteUrl] = useState("");
  const [uploading, setUploading] = useState<{ provider: Provider; recordingId: string; percent: number }>();
  const [cloudError, setCloudError] = useState<string>();
  const [transcribingId, setTranscribingId] = useState<string>();
  const [transcriptionStatus, setTranscriptionStatus] = useState("");
  const [transcriptionError, setTranscriptionError] = useState<string>();
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [backupProgress, setBackupProgress] = useState<number>();
  const [backupError, setBackupError] = useState<string>();
  const [trimOpen, setTrimOpen] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimDuration, setTrimDuration] = useState(0);
  const [trimProgress, setTrimProgress] = useState<number>();
  const [trimError, setTrimError] = useState<string>();
  const [redactionOpen, setRedactionOpen] = useState(false);
  const [redactionMode, setRedactionMode] = useState<RedactionMask["mode"]>("cover");
  const [redactionMasks, setRedactionMasks] = useState<RedactionMask[]>([]);
  const [selectingRedaction, setSelectingRedaction] = useState(false);
  const [draftRedaction, setDraftRedaction] = useState<Omit<RedactionMask, "id">>();
  const [redactionError, setRedactionError] = useState<string>();
  const [previewAspectRatio, setPreviewAspectRatio] = useState("16 / 9");
  const redactionLayerRef = useRef<HTMLDivElement>(null);
  const redactionStartRef = useRef<{ x: number; y: number; mode: RedactionMask["mode"] } | undefined>(undefined);

  const streamRef = useRef<MediaStream>(undefined);
  const recorderRef = useRef<MediaRecorder>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const elapsedRef = useRef(0);
  const countdownTimerRef = useRef<number>(undefined);
  const pipRef = useRef<Window>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [selectedVideoUrl, setSelectedVideoUrl] = useState<string>();

  useEffect(() => {
    getRecordings().then((items) => {
      setRecordings(items);
      if (items[0]) setSelectedId(items[0].id);
    });
  }, []);

  useEffect(() => () => {
    if (liveUrl) URL.revokeObjectURL(liveUrl);
  }, [liveUrl]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(undefined), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const selected = recordings.find((item) => item.id === selectedId);

  useEffect(() => {
    if (!selected) {
      setSelectedVideoUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(selected.blob);
    setSelectedVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selected?.id, selected?.blob]);

  useEffect(() => {
    setTranscriptQuery("");
    setTranscriptionError(undefined);
  }, [selectedId]);

  useEffect(() => {
    setTrimOpen(false);
    setTrimStart(0);
    setTrimEnd(selected?.duration ?? 0);
    setTrimDuration(selected?.duration ?? 0);
    setTrimError(undefined);
  }, [selectedId]);

  useEffect(() => {
    setRedactionOpen(false);
    setRedactionMode("cover");
    setRedactionMasks([]);
    setSelectingRedaction(false);
    setDraftRedaction(undefined);
    setRedactionError(undefined);
    setPreviewAspectRatio("16 / 9");
    redactionStartRef.current = undefined;
  }, [selectedId]);

  async function transcribeTake(recording: Recording) {
    setTranscribingId(recording.id);
    setTranscriptionError(undefined);
    setTranscriptionStatus("Preparing recording audio…");
    try {
      const transcript = await transcribeRecording(
        recording.blob,
        (progress) => setTranscriptionStatus(getModelProgress(progress) ?? "Loading speech model…"),
        () => setTranscriptionStatus("Transcribing on this device…"),
      );
      const updated = { ...recording, transcript };
      await saveRecording(updated);
      setRecordings((items) => items.map((item) => item.id === updated.id ? updated : item));
      setToast(transcript.length ? "Transcript saved" : "No speech detected");
    } catch (error) {
      setTranscriptionError(error instanceof Error ? error.message : "Could not transcribe this recording.");
    } finally {
      setTranscribingId(undefined);
      setTranscriptionStatus("");
    }
  }

  function seekToSegment(segment: TranscriptSegment) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = segment.start;
  }

  function getRedactionPoint(clientX: number, clientY: number) {
    const video = videoRef.current;
    const layer = redactionLayerRef.current;
    if (!video || !layer || !video.videoWidth || !video.videoHeight) return undefined;
    const bounds = layer.getBoundingClientRect();
    const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const left = bounds.left + (bounds.width - width) / 2;
    const top = bounds.top + (bounds.height - height) / 2;
    const x = (clientX - left) / width;
    const y = (clientY - top) / height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
    return { x, y };
  }

  function beginRedaction(event: ReactPointerEvent<HTMLDivElement>) {
    if (!selectingRedaction) return;
    const point = getRedactionPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    redactionStartRef.current = { ...point, mode: redactionMode };
    setDraftRedaction({ ...point, width: 0, height: 0, mode: redactionMode });
  }

  function updateRedaction(event: ReactPointerEvent<HTMLDivElement>) {
    const start = redactionStartRef.current;
    const point = getRedactionPoint(event.clientX, event.clientY);
    if (!start || !point) return;
    setDraftRedaction({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
      mode: start.mode,
    });
  }

  function finishRedaction(event: ReactPointerEvent<HTMLDivElement>) {
    const start = redactionStartRef.current;
    const point = getRedactionPoint(event.clientX, event.clientY);
    if (start && point) {
      const mask = {
        id: crypto.randomUUID(),
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
        mode: start.mode,
      };
      if (mask.width >= 0.005 && mask.height >= 0.005) {
        setRedactionMasks((masks) => [...masks, mask]);
      }
    }
    redactionStartRef.current = undefined;
    setDraftRedaction(undefined);
    setSelectingRedaction(false);
  }

  const visibleTranscript = selected?.transcript
    ? searchTranscript(selected.transcript, transcriptQuery)
    : undefined;

  async function exportBackup() {
    if (!recordings.length || backupProgress !== undefined) return;
    setBackupError(undefined);
    setBackupProgress(0);
    try {
      const backup = await createLibraryBackup(recordings, (written, total) => {
        setBackupProgress(total ? Math.min(100, Math.round((written / total) * 100)) : 100);
      });
      const url = URL.createObjectURL(backup);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `Take-Three-Backup-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast(`Backed up ${recordings.length} ${recordings.length === 1 ? "take" : "takes"}`);
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "Could not export the library backup.");
    } finally {
      setBackupProgress(undefined);
    }
  }

  async function saveEditedTake() {
    if (!selected || !videoRef.current || trimProgress !== undefined) return;
    const video = videoRef.current;
    const start = Math.max(0, trimStart);
    const end = Math.min(trimEnd, video.duration);
    const hasTrim = start > 0 || end < video.duration - 0.1;
    const hasRedactions = redactionMasks.length > 0;
    if (!hasTrim && !hasRedactions) return;
    if (!Number.isFinite(end) || end - start < 0.1) {
      setTrimError("Choose a clip that is at least 0.1 seconds long.");
      return;
    }

    setTrimError(undefined);
    setRedactionError(undefined);
    setTrimProgress(0);
    try {
      const blob = await renderTrimmedWebM(video, start, end, setTrimProgress, redactionMasks);
      const duration = await new Promise<number>((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const preview = document.createElement("video");
        preview.preload = "metadata";
        preview.onloadedmetadata = () => {
          URL.revokeObjectURL(url);
          resolve(Number.isFinite(preview.duration) ? preview.duration : end - start);
        };
        preview.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("Could not read the trimmed recording."));
        };
        preview.src = url;
      });
      const trimmed: Recording = {
        id: crypto.randomUUID(),
        title: `${selected.title} ${hasTrim && hasRedactions ? "(edited)" : hasTrim ? "(trimmed)" : "(redacted)"}`,
        createdAt: Date.now(),
        duration,
        blob,
        thumbnail: await captureThumbnail(blob),
      };
      await saveRecording(trimmed);
      setRecordings((items) => [trimmed, ...items]);
      setSelectedId(trimmed.id);
      setToast("Trimmed copy saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create this edited copy.";
      setTrimError(message);
      setRedactionError(message);
    } finally {
      setTrimProgress(undefined);
    }
  }

  function beep() {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    oscillator.connect(gain);
    gain.connect(context.destination);
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
  }

  async function startRecording() {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: true,
      });
      let combined = display;
      if (micEnabled) {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        combined = new MediaStream([
          ...display.getVideoTracks(),
          ...display.getAudioTracks(),
          ...mic.getAudioTracks(),
        ]);
        mic.getTracks().forEach((track) => display.addTrack(track));
      }
      streamRef.current = combined;

      setCountdown(3);
      beep();
      countdownTimerRef.current = window.setInterval(() => {
        setCountdown((current) => {
          if (current === undefined) return undefined;
          if (current <= 1) {
            window.clearInterval(countdownTimerRef.current);
            startCapture(combined);
            return undefined;
          }
          beep();
          return current - 1;
        });
      }, 1000);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not start screen recording");
    }
  }

  function startCapture(stream: MediaStream) {
    chunksRef.current = [];
    elapsedRef.current = 0;
    setElapsed(0);
    setPreviewMode("recording");
    setIsRecording(true);
    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm",
    });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunksRef.current.push(event.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      if (liveUrl) URL.revokeObjectURL(liveUrl);
      setLiveUrl(URL.createObjectURL(blob));
      setPreviewMode("review");
      setDraftTitle("");
      stream.getTracks().forEach((track) => track.stop());
    };
    recorder.start(1000);
    const timer = window.setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
    }, 1000);
    recorder.addEventListener("stop", () => window.clearInterval(timer), { once: true });
  }

  function cancelCountdown() {
    if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current);
    setCountdown(undefined);
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setIsRecording(false);
  }

  async function openPip() {
    const pipApi = window as Window & {
      documentPictureInPicture?: {
        requestWindow: (options: { width: number; height: number }) => Promise<Window>;
      };
    };
    if (!pipApi.documentPictureInPicture) return;
    const pip = await pipApi.documentPictureInPicture.requestWindow({ width: 260, height: 180 });
    pip.document.body.innerHTML = `
      <style>
        *{box-sizing:border-box} body{margin:0;background:#16243c;color:white;font:600 14px -apple-system,BlinkMacSystemFont,"Avenir Next",sans-serif}
        main{height:100vh;display:grid;place-content:center;text-align:center;gap:12px}
        strong{font-size:34px;font-variant-numeric:tabular-nums} button{border:0;border-radius:999px;background:#bd3545;color:white;padding:10px 18px;font-weight:700}
      </style>
      <main><span>Take Three</span><strong id="timer">${formatTime(elapsed)}</strong><button id="stop">Stop recording</button></main>
    `;
    const button = pip.document.querySelector("#stop");
    button?.addEventListener("click", stopRecording);
    pipRef.current = pip;
  }

  useEffect(() => {
    if (pipRef.current?.document) {
      const timer = pipRef.current.document.querySelector("#timer");
      if (timer) timer.textContent = formatTime(elapsed);
    }
  }, [elapsed]);

  async function captureThumbnail(blob: Blob): Promise<string | undefined> {
    const video = document.createElement("video");
    video.src = URL.createObjectURL(blob);
    video.muted = true;
    await new Promise<void>((resolve) => {
      video.onloadeddata = () => resolve();
    });
    const time = Math.min(1, (video.duration || 2) / 2);
    await new Promise<void>((resolve) => {
      video.currentTime = time;
      video.onseeked = () => resolve();
    });
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    context?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const thumbnail = canvas.toDataURL("image/jpeg", 0.82);
    URL.revokeObjectURL(video.src);
    return thumbnail;
  }

  async function saveTake() {
    if (!liveUrl) return;
    const blob = await fetch(liveUrl).then((response) => response.blob());
    const recording: Recording = {
      id: crypto.randomUUID(),
      title: draftTitle.trim() || `Take ${recordings.length + 1}`,
      createdAt: Date.now(),
      duration: elapsedRef.current,
      blob,
    };
    recording.thumbnail = await captureThumbnail(blob);
    await saveRecording(recording);
    setRecordings((items) => [recording, ...items]);
    setSelectedId(recording.id);
    setPreviewMode("idle");
    setLiveUrl(undefined);
    setToast("Recording saved");
  }

  async function uploadThumbnail(file: File) {
    if (!selected) return;
    if (file.size > 10 * 1024 * 1024) {
      setToast("Choose an image smaller than 10 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const updated = { ...selected, thumbnail: String(reader.result) };
      await saveRecording(updated);
      setRecordings((items) => items.map((item) => item.id === updated.id ? updated : item));
      setToast("Thumbnail updated");
    };
    reader.readAsDataURL(file);
  }

  function downloadRecording(recording: Recording) {
    const url = URL.createObjectURL(recording.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${recording.title.replace(/[^\w.-]+/g, "-")}.webm`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function removeRecording(recording: Recording) {
    await deleteRecording(recording.id);
    setRecordings((items) => items.filter((item) => item.id !== recording.id));
    setSelectedId(undefined);
  }

  async function connect(provider: Provider) {
    setCloudError(undefined);
    setConnecting(provider);
    try {
      const token = await (provider === "SharePoint" ? connectMicrosoft() : connectGoogle());
      setTokens((current) => ({ ...current, [provider]: token }));
    } catch (error) {
      setCloudError(error instanceof Error ? error.message : `Could not connect ${provider}.`);
    } finally {
      setConnecting(undefined);
    }
  }

  async function publish(recording: Recording, provider: Provider) {
    const token = tokens[provider];
    setCloudError(undefined);
    if (!token || (provider === "SharePoint" && !siteUrl.trim())) {
      setSettingsOpen(true);
      setCloudError(!token ? `Connect ${provider} before uploading.` : "Enter your SharePoint site URL before uploading.");
      return;
    }
    setUploading({ provider, recordingId: recording.id, percent: 0 });
    const progress = (percent: number) => setUploading({ provider, recordingId: recording.id, percent });
    try {
      const result = provider === "SharePoint"
        ? await uploadSharePoint(token, siteUrl.trim(), recording.title, recording.blob, progress)
        : await uploadGoogle(token, recording.title, recording.blob, progress);
      const updated = { ...recording, uploads: [...(recording.uploads || []), result] };
      setRecordings((items) => items.map((item) => item.id === recording.id ? updated : item));
      try {
        await saveRecording(updated);
        setToast(`Uploaded to ${provider}`);
      } catch {
        setCloudError(`Uploaded to ${provider}, but the link could not be saved locally. Open it below before reloading.`);
      }
    } catch (error) {
      if (error instanceof CloudHttpError && error.status === 401) {
        setTokens((current) => ({ ...current, [provider]: undefined }));
      }
      setCloudError(error instanceof TypeError
        ? `The connection to ${provider} was interrupted. Check the destination for a completed upload before retrying.`
        : error instanceof Error ? error.message : `${provider} upload failed. Check the destination before retrying.`);
    } finally {
      setUploading(undefined);
    }
  }

  const pipSupported = "documentPictureInPicture" in window;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">03</span>
          <span>Take Three</span>
          <span className="brand-note">PERSONAL SCREEN STUDIO</span>
        </div>
        <div className="top-actions">
          <button
            className="secondary-button backup-button"
            onClick={exportBackup}
            disabled={!recordings.length || backupProgress !== undefined}
            aria-label="Export library backup"
          >
            <Download />
            <span>{backupProgress === undefined ? "Backup library" : `Exporting ${backupProgress}%`}</span>
          </button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Settings"><Settings /></button>
        </div>
      </header>

      <section className="workspace">
        <div className="recorder-panel">
          <div className="panel-heading">
            <div>
              <span className="section-name">New recording</span>
              <h1>{previewMode === "recording" ? "Recording" : previewMode === "review" ? "Review take" : "Ready to record"}</h1>
            </div>
            {previewMode === "recording" && (
              <span className="live-clock"><i /> {formatTime(elapsed)}</span>
            )}
          </div>

          <div className={`viewfinder ${previewMode}`}>
            {countdown !== undefined ? (
              <div className="countdown"><strong>{countdown}</strong><button onClick={cancelCountdown}>Cancel</button></div>
            ) : liveUrl && previewMode !== "idle" ? (
              <video src={liveUrl} controls playsInline />
            ) : previewMode === "recording" ? (
              <div className="recording-surface"><span className="record-dot" /><span>Capturing your screen</span></div>
            ) : (
              <div className="viewfinder-empty">
                <div className="viewfinder-target"><Monitor /></div>
                <span>Choose a screen or window</span>
              </div>
            )}
          </div>

          <div className="record-controls">
            <button
              className={`mic-button ${micEnabled ? "on" : ""}`}
              onClick={() => setMicEnabled((value) => !value)}
              aria-pressed={micEnabled}
            >
              <Mic /><span>Microphone</span><span className="mic-status">{micEnabled ? "On" : "Off"}</span>
            </button>

            {previewMode === "recording" ? (
              <div className="record-actions">
                {pipSupported && <button className="secondary-button" onClick={openPip}><PictureInPicture2 /> Pop out</button>}
                <button className="stop-button" onClick={stopRecording}><Square fill="currentColor" /> Stop</button>
              </div>
            ) : previewMode === "review" ? (
              <div className="record-actions">
                <input
                  className="title-input"
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder="Name this take"
                  aria-label="Recording title"
                />
                <button className="secondary-button" onClick={() => { setPreviewMode("idle"); setLiveUrl(undefined); }}>Discard</button>
                <button className="primary-button" onClick={saveTake}>Save take</button>
              </div>
            ) : (
              <button className="record-button" onClick={startRecording}><span /> Start recording</button>
            )}
          </div>
        </div>

        <aside className="library-panel">
          <div className="library-heading"><h2>Library</h2><span>{recordings.length} {recordings.length === 1 ? "take" : "takes"}</span></div>
          {recordings.length === 0 ? (
            <div className="empty-library"><div><Play /></div><p>Your saved takes will appear here.</p></div>
          ) : (
            <div className="library-list">
              {recordings.map((recording) => (
                <button
                  key={recording.id}
                  className={`library-card ${selectedId === recording.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(recording.id)}
                  disabled={trimProgress !== undefined}
                >
                  <div className="thumbnail">
                    {recording.thumbnail ? <img src={recording.thumbnail} alt="" /> : <div><Play /></div>}
                  </div>
                  <div className="library-meta">
                    <strong>{recording.title}</strong>
                    <span>{new Date(recording.createdAt).toLocaleDateString()} · {formatTime(recording.duration)}</span>
                  </div>
                  <MoreHorizontal />
                </button>
              ))}
            </div>
          )}
        </aside>
      </section>

      {selected && (
        <section className="detail-panel">
          <div className="detail-heading">
            <div><span className="section-name">Selected take</span><h2>{selected.title}</h2></div>
            <div className="detail-actions">
              <button
                className="icon-button"
                onClick={() => {
                  if (redactionOpen) {
                    redactionStartRef.current = undefined;
                    setSelectingRedaction(false);
                    setDraftRedaction(undefined);
                  }
                  setRedactionOpen((open) => !open);
                  setRedactionError(undefined);
                }}
                disabled={trimProgress !== undefined}
                aria-label="Cover or blur sensitive areas"
                title="Cover or blur"
              ><EyeOff /></button>
              <button
                className="icon-button"
                onClick={() => { setTrimOpen((open) => !open); setTrimError(undefined); }}
                disabled={trimProgress !== undefined}
                aria-label="Trim beginning and end"
                title="Trim a copy"
              ><Scissors /></button>
              <button className="icon-button" onClick={() => downloadRecording(selected)} aria-label="Download"><Download /></button>
              <button className="icon-button danger" onClick={() => removeRecording(selected)} disabled={!!uploading || transcribingId === selected.id || trimProgress !== undefined} aria-label="Delete"><Trash2 /></button>
            </div>
          </div>
          <div className="detail-grid">
            <div className="detail-preview" style={{ aspectRatio: previewAspectRatio }}>
              <video
                ref={videoRef}
                src={selectedVideoUrl}
                poster={selected.thumbnail}
                controls={trimProgress === undefined && !selectingRedaction}
                preload="metadata"
                aria-label={`Preview ${selected.title}`}
                onLoadedMetadata={(event) => {
                  const duration = event.currentTarget.duration;
                  if (!Number.isFinite(duration)) return;
                  if (event.currentTarget.videoWidth && event.currentTarget.videoHeight) {
                    setPreviewAspectRatio(`${event.currentTarget.videoWidth} / ${event.currentTarget.videoHeight}`);
                  }
                  setTrimDuration(duration);
                  setTrimEnd((current) => current === selected.duration
                    ? duration
                    : Math.min(current || duration, duration));
                  setTrimStart((current) => Math.min(current, Math.max(0, duration - 0.1)));
                }}
              />
              {redactionOpen && (
                <div
                  ref={redactionLayerRef}
                  className={`redaction-layer ${selectingRedaction ? "selecting" : ""}`}
                  onPointerDown={beginRedaction}
                  onPointerMove={updateRedaction}
                  onPointerUp={finishRedaction}
                  onPointerCancel={() => {
                    redactionStartRef.current = undefined;
                    setDraftRedaction(undefined);
                    setSelectingRedaction(false);
                  }}
                  aria-label="Redaction mask drawing area"
                >
                  {redactionMasks.map((mask) => (
                    <span
                      key={mask.id}
                      className={`redaction-mask ${mask.mode}`}
                      style={{
                        left: `${mask.x * 100}%`,
                        top: `${mask.y * 100}%`,
                        width: `${mask.width * 100}%`,
                        height: `${mask.height * 100}%`,
                      }}
                    />
                  ))}
                  {draftRedaction && (
                    <span
                      className={`redaction-mask draft ${draftRedaction.mode}`}
                      style={{
                        left: `${draftRedaction.x * 100}%`,
                        top: `${draftRedaction.y * 100}%`,
                        width: `${draftRedaction.width * 100}%`,
                        height: `${draftRedaction.height * 100}%`,
                      }}
                    />
                  )}
                </div>
              )}
            </div>
            <div className="detail-fields">
              <label>Thumbnail
                <div className="thumbnail-upload">
                  <Upload />
                  <span>{selected.thumbnail ? "Replace image" : "Upload image"}</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp" disabled={!!uploading} onChange={(event) => event.target.files?.[0] && uploadThumbnail(event.target.files[0])} />
                </div>
              </label>
              <div className="publish-option">Publish to
                <div className="publish-row">
                  {(["SharePoint", "Google Drive"] as Provider[]).map((provider) => (
                    <button key={provider} disabled={!!uploading} onClick={() => publish(selected, provider)}><Cloud /> {provider}</button>
                  ))}
                </div>
                <span>Uploads use the destination's existing sharing permissions.</span>
                {uploading?.recordingId === selected.id && <span role="status">Uploading to {uploading.provider}: {uploading.percent}%</span>}
                {selected.uploads?.map((upload, index) => (
                  <a key={`${upload.url}-${index}`} className="published-link" href={upload.url} target="_blank" rel="noreferrer">
                    Open {upload.name} in {upload.provider} <ExternalLink />
                  </a>
                ))}
              </div>
            </div>
          </div>
          {trimOpen && (
            <section className="trim-panel" aria-label="Trim recording">
              <div className="transcript-heading">
                <div>
                  <span className="section-name">Keep the original safe</span>
                  <h3><Scissors /> Trim a copy</h3>
                </div>
                <button className="secondary-button" onClick={() => setTrimOpen(false)} disabled={trimProgress !== undefined}>Cancel</button>
              </div>
              <p className="trim-note">
                Choose the section to keep. This browser re-encodes it in real time; the start and end can shift slightly to a nearby frame.
              </p>
              <div className="trim-fields">
                <label>Start
                  <div className="trim-time-input">
                    <input
                      type="number"
                      min="0"
                      max={Math.max(0, trimEnd - 0.1)}
                      step="0.1"
                      value={trimStart}
                      disabled={trimProgress !== undefined}
                      onChange={(event) => setTrimStart(Math.max(0, Math.min(Number(event.target.value), trimEnd - 0.1)))}
                    />
                    <button className="secondary-button" onClick={() => setTrimStart(Math.max(0, Math.min(videoRef.current?.currentTime ?? 0, trimEnd - 0.1)))} disabled={trimProgress !== undefined}>Use playhead</button>
                  </div>
                  <input
                    className="trim-range"
                    type="range"
                    min="0"
                    max={Math.max(0.1, trimDuration - 0.1)}
                    step="0.1"
                    value={Math.min(trimStart, Math.max(0, trimDuration - 0.1))}
                    aria-label="Clip start time"
                    disabled={trimProgress !== undefined}
                    onChange={(event) => setTrimStart(Math.min(Number(event.target.value), trimEnd - 0.1))}
                  />
                </label>
                <label>End
                  <div className="trim-time-input">
                    <input
                      type="number"
                      min={trimStart + 0.1}
                      max={trimDuration}
                      step="0.1"
                      value={trimEnd}
                      disabled={trimProgress !== undefined}
                      onChange={(event) => setTrimEnd(Math.max(trimStart + 0.1, Math.min(Number(event.target.value), trimDuration)))}
                    />
                    <button className="secondary-button" onClick={() => setTrimEnd(Math.max(trimStart + 0.1, Math.min(videoRef.current?.currentTime ?? trimDuration, trimDuration)))} disabled={trimProgress !== undefined}>Use playhead</button>
                  </div>
                  <input
                    className="trim-range"
                    type="range"
                    min={Math.min(trimDuration, trimStart + 0.1)}
                    max={Math.max(trimDuration, 0.1)}
                    step="0.1"
                    value={Math.max(trimStart + 0.1, Math.min(trimEnd, trimDuration))}
                    aria-label="Clip end time"
                    disabled={trimProgress !== undefined}
                    onChange={(event) => setTrimEnd(Math.max(trimStart + 0.1, Number(event.target.value)))}
                  />
                </label>
              </div>
              <div className="trim-summary">
                <span>Keep {formatTrimTime(trimStart)} – {formatTrimTime(trimEnd)}</span>
                <span>{formatTrimTime(Math.max(0, trimEnd - trimStart))} clip</span>
              </div>
              {trimProgress !== undefined && (
                <p className="transcription-status" role="status">Creating trimmed copy · {Math.round(trimProgress * 100)}%</p>
              )}
              {trimError && <p className="cloud-error" role="alert">{trimError}</p>}
              <div className="trim-footer">
                <span>The original stays unchanged. The new copy will need a fresh transcript and upload.</span>
                <button
                  className="primary-button"
                  onClick={saveEditedTake}
                  disabled={trimProgress !== undefined || trimStart <= 0 && trimEnd >= trimDuration && !redactionMasks.length || trimEnd - trimStart < 0.1}
                >
                  {trimProgress === undefined ? redactionMasks.length ? "Create edited copy" : "Create trimmed copy" : "Rendering…"}
                </button>
              </div>
            </section>
          )}
          {redactionOpen && (
            <section className="redaction-panel" aria-label="Cover or blur sensitive areas">
              <div className="transcript-heading">
                <div>
                  <span className="section-name">Redact before sharing</span>
                  <h3><EyeOff /> Sensitive areas</h3>
                </div>
                <div className="redaction-modes" role="group" aria-label="Redaction style">
                  <button
                    className={redactionMode === "cover" ? "selected" : ""}
                    onClick={() => setRedactionMode("cover")}
                    aria-pressed={redactionMode === "cover"}
                    disabled={selectingRedaction || trimProgress !== undefined}
                  >Solid cover</button>
                  <button
                    className={redactionMode === "blur" ? "selected" : ""}
                    onClick={() => setRedactionMode("blur")}
                    aria-pressed={redactionMode === "blur"}
                    disabled={selectingRedaction || trimProgress !== undefined}
                  >Blur</button>
                </div>
              </div>
              <p className="redaction-note">
                {redactionMode === "cover"
                  ? "Solid cover is recommended for passwords and private details."
                  : "Blur is less reliable for secrets; text may still be recoverable. Masks stay fixed as the video plays."}
              </p>
              <div className="redaction-actions">
                <button
                  className={selectingRedaction ? "stop-button" : "secondary-button"}
                  onClick={() => {
                    if (selectingRedaction) {
                      redactionStartRef.current = undefined;
                      setDraftRedaction(undefined);
                    }
                    setSelectingRedaction((value) => !value);
                  }}
                  disabled={trimProgress !== undefined}
                >
                  {selectingRedaction ? "Cancel drawing" : "Draw area"}
                </button>
                <span>{selectingRedaction ? "Drag over the preview to mark an area." : `${redactionMasks.length} ${redactionMasks.length === 1 ? "area" : "areas"} marked`}</span>
              </div>
              {!!redactionMasks.length && (
                <ul className="redaction-list">
                  {redactionMasks.map((mask, index) => (
                    <li key={mask.id}>
                      <span>Area {index + 1} · {mask.mode === "cover" ? "Solid cover" : "Blur"}</span>
                      <button
                        className="secondary-button"
                        onClick={() => setRedactionMasks((items) => items.filter((item) => item.id !== mask.id))}
                        disabled={trimProgress !== undefined}
                      >Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              {redactionError && <p className="cloud-error" role="alert">{redactionError}</p>}
              <div className="trim-footer">
                <span>Creates a new local copy with masks baked in. Any current trim range also applies.</span>
                <button
                  className="primary-button"
                  onClick={saveEditedTake}
                  disabled={!redactionMasks.length || trimProgress !== undefined || trimEnd - trimStart < 0.1}
                >
                  {trimProgress === undefined ? "Create redacted copy" : "Rendering…"}
                </button>
              </div>
            </section>
          )}
          <section className="transcript-panel" aria-label="Recording transcript">
            <div className="transcript-heading">
              <div>
                <span className="section-name">On-device transcription</span>
                <h3><AudioLines /> Transcript</h3>
              </div>
              <button
                className="secondary-button transcript-action"
                onClick={() => transcribeTake(selected)}
                disabled={!!transcribingId}
              >
                {transcribingId === selected.id
                  ? <><LoaderCircle className="spinner" /> Working…</>
                  : selected.transcript ? "Regenerate" : "Create transcript"}
              </button>
            </div>
            <p className="transcript-note">
              Speech is processed in this browser. The first run downloads a model; your recording is not uploaded for transcription.
            </p>
            {transcribingId === selected.id && (
              <p className="transcription-status" role="status">{transcriptionStatus}</p>
            )}
            {transcriptionError && <p className="cloud-error" role="alert">{transcriptionError}</p>}
            {selected.transcript && (
              <>
                <label className="transcript-search">
                  <Search />
                  <input
                    type="search"
                    value={transcriptQuery}
                    onChange={(event) => setTranscriptQuery(event.target.value)}
                    placeholder="Search transcript"
                    aria-label="Search transcript"
                  />
                </label>
                {visibleTranscript?.length ? (
                  <ol className="transcript-list">
                    {visibleTranscript.map((segment, index) => (
                      <li key={`${segment.start}-${index}`}>
                        <button className="transcript-segment" onClick={() => seekToSegment(segment)}>
                          <time>{formatTime(segment.start)}</time>
                          <span>{segment.text}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="transcript-empty">
                    {selected.transcript.length ? "No matching transcript segments." : "No speech was detected in this recording."}
                  </p>
                )}
              </>
            )}
          </section>
        </section>
      )}

      {backupError && <div className="cloud-alert" role="alert">{backupError}<button onClick={() => setBackupError(undefined)} aria-label="Dismiss backup error"><X /></button></div>}
      {cloudError && !settingsOpen && <div className="cloud-alert" role="alert">{cloudError}<button onClick={() => setCloudError(undefined)} aria-label="Dismiss error"><X /></button></div>}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-label="Storage connections" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading"><div><span className="section-name">Storage</span><h2>Cloud services</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close"><X /></button></div>
            {(["SharePoint", "Google Drive"] as Provider[]).map((provider) => (
                <div className="provider-row" key={provider}>
                  <div className="provider-icon">{provider === "SharePoint" ? "S" : "G"}</div>
                  <div><strong>{provider}</strong><span>{tokens[provider] ? "Connected for this session" : "Not connected"}</span></div>
                  {tokens[provider] ? (
                    <button className="secondary-button" disabled={!!uploading} onClick={() => setTokens((current) => ({ ...current, [provider]: undefined }))}>Disconnect</button>
                  ) : (
                    <button className="primary-button" disabled={!!connecting || !!uploading} onClick={() => connect(provider)}>{connecting === provider ? "Connecting..." : "Connect"}</button>
                  )}
                </div>
            ))}
            <label className="site-field">SharePoint site URL
              <input type="url" placeholder="https://company.sharepoint.com/sites/team" value={siteUrl} disabled={!!uploading} onChange={(event) => setSiteUrl(event.target.value)} />
            </label>
            {cloudError && <p className="cloud-error" role="alert">{cloudError}</p>}
            <p className="settings-note">Set up OAuth client IDs before connecting. Uploads go to My Drive or the SharePoint site's default document library. Connections last until this page is reloaded.</p>
          </section>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

export default App;
