import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { createLibraryBackup } from "./backup";

describe("library backups", () => {
  it("exports recordings and their metadata in one ZIP archive", async () => {
    const progress = vi.fn();
    const backup = await createLibraryBackup([{
      id: "take-1",
      title: "Walkthrough",
      createdAt: 123,
      duration: 8,
      blob: new Blob(["webm-data"], { type: "video/webm" }),
      thumbnail: "data:image/jpeg;base64,abc",
      transcript: [{ start: 1.5, end: 3, text: "Hello" }],
    }], progress);

    const files = unzipSync(new Uint8Array(await backup.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));

    expect(manifest.format).toBe("take-three-library-backup");
    expect(manifest.version).toBe(1);
    expect(manifest.recordings[0]).toMatchObject({
      id: "take-1",
      title: "Walkthrough",
      videoPath: "recordings/001-take-1.webm",
      transcript: [{ start: 1.5, end: 3, text: "Hello" }],
    });
    expect(new TextDecoder().decode(files[manifest.recordings[0].videoPath])).toBe("webm-data");
    expect(progress).toHaveBeenLastCalledWith(9, 9);
  });
});
