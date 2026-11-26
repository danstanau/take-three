import { useEffect, useRef, useState } from "react";
import {
  Cloud,
  Download,
  ExternalLink,
  Mic,
  Monitor,
  MoreHorizontal,
  PictureInPicture2,
  Play,
  Settings,
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

type Recording = {
  id: string;
  title: string;
  createdAt: number;
  duration: number;
  blob: Blob;
  thumbnail?: string;
  uploads?: UploadResult[];
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

  const streamRef = useRef<MediaStream>(undefined);
  const recorderRef = useRef<MediaRecorder>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const elapsedRef = useRef(0);
  const countdownTimerRef = useRef<number>(undefined);
  const pipRef = useRef<Window>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);

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
        <div className="brand"><span className="brand-mark"><Play fill="currentColor" /></span><span>Take Three</span></div>
        <div className="top-actions">
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
              <button className="icon-button" onClick={() => downloadRecording(selected)} aria-label="Download"><Download /></button>
              <button className="icon-button danger" onClick={() => removeRecording(selected)} disabled={!!uploading} aria-label="Delete"><Trash2 /></button>
            </div>
          </div>
          <div className="detail-grid">
            <div className="detail-preview">
              {selected.thumbnail && <img src={selected.thumbnail} alt="" />}
              <button onClick={() => {
                const url = URL.createObjectURL(selected.blob);
                const video = window.open(url, "_blank");
                if (video) video.addEventListener("beforeunload", () => URL.revokeObjectURL(url));
              }}><Play fill="currentColor" /></button>
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
        </section>
      )}

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
