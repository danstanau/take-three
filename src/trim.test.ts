import { afterEach, describe, expect, it, vi } from "vitest";
import { drawRedactions, renderTrimmedWebM } from "./trim";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser-native trimming", () => {
  it("draws an opaque cover at normalized video coordinates", () => {
    const context = { fillStyle: "", fillRect: vi.fn() } as unknown as CanvasRenderingContext2D;
    const video = { videoWidth: 1000, videoHeight: 500 } as HTMLVideoElement;

    drawRedactions(context, video, [{
      id: "mask",
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      mode: "cover",
    }]);

    expect(context.fillStyle).toBe("#101713");
    expect(context.fillRect).toHaveBeenCalledWith(100, 100, 300, 200);
  });

  it("applies a clipped blur only inside the selected mask", () => {
    const context = {
      save: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      filter: "none",
      drawImage: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const video = { videoWidth: 1000, videoHeight: 500 } as HTMLVideoElement;

    drawRedactions(context, video, [{
      id: "mask",
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      mode: "blur",
    }]);

    expect(context.rect).toHaveBeenCalledWith(100, 100, 300, 200);
    expect(context.filter).toBe("blur(24px)");
    expect(context.restore).toHaveBeenCalledOnce();
  });

  it("rejects invalid time ranges before accessing the media element", async () => {
    await expect(renderTrimmedWebM({} as HTMLVideoElement, 4, 2))
      .rejects.toThrow("Choose a valid start and end time.");
  });

  it("records the selected playback range into a new WebM", async () => {
    const track = { stop: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const captureStream = vi.fn(() => stream);
    const mediaState = { currentTime: 0, paused: true, ended: false };
    const video = Object.assign(mediaState, {
      currentTime: 0,
      paused: true,
      ended: false,
      captureStream,
      pause() { mediaState.paused = true; },
      play() {
        mediaState.paused = false;
        return Promise.resolve();
      },
    }) as unknown as HTMLVideoElement;

    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported = vi.fn(() => true);
      mimeType = "video/webm;codecs=vp9,opus";
      state = "inactive";

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        const data = new Event("dataavailable");
        Object.defineProperty(data, "data", { value: new Blob(["trimmed"]) });
        this.dispatchEvent(data);
        this.dispatchEvent(new Event("stop"));
      }
    }

    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => {
        video.currentTime += 0.3;
        callback(0);
      }, 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => clearTimeout(frame));

    const progress = vi.fn();
    const result = await renderTrimmedWebM(video, 1, 2, progress);

    expect(await result.text()).toBe("trimmed");
    expect(progress).toHaveBeenLastCalledWith(1);
    expect(captureStream).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.currentTime).toBe(0);
  });
});
