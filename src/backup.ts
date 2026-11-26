import type { UploadResult } from "./cloud";
import type { TranscriptSegment } from "./transcription";

export type BackupRecording = {
  id: string;
  title: string;
  createdAt: number;
  duration: number;
  blob: Blob;
  thumbnail?: string;
  uploads?: UploadResult[];
  transcript?: TranscriptSegment[];
};

type BackupManifest = {
  format: "take-three-library-backup";
  version: 1;
  exportedAt: string;
  recordings: Array<Omit<BackupRecording, "blob"> & { videoPath: string }>;
};

export async function createLibraryBackup(
  recordings: BackupRecording[],
  onProgress?: (written: number, total: number) => void,
): Promise<Blob> {
  const { Zip, ZipPassThrough } = await import("fflate");
  const manifest: BackupManifest = {
    format: "take-three-library-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    recordings: recordings.map(({ blob, ...recording }, index) => ({
      ...recording,
      videoPath: `recordings/${String(index + 1).padStart(3, "0")}-${recording.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.webm`,
    })),
  };
  const totalBytes = recordings.reduce((sum, recording) => sum + recording.blob.size, 0);
  let written = 0;
  onProgress?.(written, totalBytes);

  const output: BlobPart[] = [];
  let resolveArchive!: (blob: Blob) => void;
  let rejectArchive!: (error: Error) => void;
  const archivePromise = new Promise<Blob>((resolve, reject) => {
    resolveArchive = resolve;
    rejectArchive = reject;
  });
  const archive = new Zip((error, chunk, final) => {
    if (error) {
      rejectArchive(error);
      return;
    }
    if (chunk.byteLength) output.push(chunk.slice().buffer);
    if (final) resolveArchive(new Blob(output, { type: "application/zip" }));
  });

  function addBytes(path: string, bytes: Uint8Array) {
    const file = new ZipPassThrough(path);
    archive.add(file);
    file.push(bytes, true);
  }

  try {
    addBytes("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2)));

    for (const [index, recording] of recordings.entries()) {
      const file = new ZipPassThrough(manifest.recordings[index].videoPath);
      archive.add(file);
      const reader = recording.blob.stream().getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            file.push(new Uint8Array(), true);
            break;
          }
          file.push(value, false);
          written += value.byteLength;
          if (written === totalBytes || written % (4 * 1024 * 1024) < value.byteLength) {
            onProgress?.(written, totalBytes);
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
  } catch (error) {
    archive.terminate();
    throw error;
  }

  archive.end();
  return archivePromise;
}
