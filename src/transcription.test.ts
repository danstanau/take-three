import { describe, expect, it } from "vitest";
import { searchTranscript, toTranscriptSegments } from "./transcription";

describe("transcript segments", () => {
  it("keeps searchable text with the model's timestamps", () => {
    expect(toTranscriptSegments({
      text: " Hello world",
      chunks: [{ text: " Hello world ", timestamp: [2.4, 4.8] }],
    })).toEqual([{ start: 2.4, end: 4.8, text: "Hello world" }]);
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

  it("searches transcript text without losing its seek timestamp", () => {
    const segments = [{ start: 12, end: 15, text: "Open the project settings" }];

    expect(searchTranscript(segments, "PROJECT")).toEqual(segments);
    expect(searchTranscript(segments, "missing")).toEqual([]);
  });
});
