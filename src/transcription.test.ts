import { afterEach, describe, expect, it, vi } from "vitest";
import { pipeline } from "@huggingface/transformers";
import { searchTranscript, toTranscriptSegments, transcribeRecording } from "./transcription";

vi.mock("@huggingface/transformers", () => ({ pipeline: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe("transcript segments", () => {
  it("keeps searchable text with the model's timestamps", () => {
    expect(toTranscriptSegments({
      text: " Hello world",
      chunks: [{ text: " Hello world ", timestamp: [2.4, 4.8] }],
    })).toEqual([{ start: 2.4, end: 4.8, text: "Hello world" }]);
  });

  describe("transcribing recordings", () => {
    function mockAudio(samples: Float32Array) {
      vi.stubGlobal("AudioContext", class {
        decodeAudioData() { return Promise.resolve({ duration: samples.length / 16_000 }); }
        close() { return Promise.resolve(); }
      });
      vi.stubGlobal("OfflineAudioContext", class {
        destination = {};
        createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
        startRendering() { return Promise.resolve({ getChannelData: () => samples }); }
      });
    }

    it("does not hallucinate text for a silent recording", async () => {
      mockAudio(new Float32Array(16_000));
      await expect(transcribeRecording(new Blob(["audio"]))).resolves.toEqual([]);
      expect(pipeline).not.toHaveBeenCalled();
    });

    it("transcribes with the stronger model and retains an open-ended last segment", async () => {
      const audio = new Float32Array(16_000);
      audio[0] = 0.1;
      mockAudio(audio);
      const transcriber = vi.fn().mockResolvedValue({
        text: "hello", chunks: [{ text: " hello", timestamp: [0.2, null] }],
      });
      vi.mocked(pipeline).mockResolvedValue(transcriber as never);
      await expect(transcribeRecording(new Blob(["audio"]))).resolves.toEqual([{ start: 0.2, end: 1, text: "hello" }]);
      expect(pipeline).toHaveBeenCalledWith("automatic-speech-recognition", "onnx-community/whisper-small", expect.any(Object));
      expect(transcriber).toHaveBeenCalledWith(audio, expect.objectContaining({ max_new_tokens: 448, return_timestamps: true }));
    });
  });

  it("drops empty or untimed chunks", () => {
    expect(toTranscriptSegments({
      text: "",
      chunks: [
        { text: "   ", timestamp: [0, 1] },
        { text: "No time", timestamp: [Number.NaN, 2] },
      ],
    })).toEqual([]);
  });

  it("keeps a final segment with an open end and clamps timestamps to the recording", () => {
    expect(toTranscriptSegments({
      text: "hello",
      chunks: [{ text: "hello", timestamp: [2, null] }],
    }, 7)).toEqual([{ start: 2, end: 7, text: "hello" }]);
    expect(toTranscriptSegments({
      text: "hello",
      chunks: [{ text: "hello", timestamp: [2, 20] }],
    }, 7)).toEqual([{ start: 2, end: 7, text: "hello" }]);
  });

  it("uses the next segment start for an open end and drops timestamps beyond the audio", () => {
    expect(toTranscriptSegments({
      text: "first second",
      chunks: [
        { text: "first", timestamp: [1, null] },
        { text: "second", timestamp: [4, 6] },
        { text: "past the end", timestamp: [15, 16] },
      ],
    }, 10)).toEqual([
      { start: 1, end: 4, text: "first" },
      { start: 4, end: 6, text: "second" },
    ]);
  });

  it("searches transcript text without losing its seek timestamp", () => {
    const segments = [{ start: 12, end: 15, text: "Open the project settings" }];

    expect(searchTranscript(segments, "PROJECT")).toEqual(segments);
    expect(searchTranscript(segments, "missing")).toEqual([]);
  });
});
