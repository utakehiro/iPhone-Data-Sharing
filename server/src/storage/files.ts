import { promises as fs } from "node:fs";
import path from "node:path";
import { files } from "../state.js";

export const uploadDirectory = path.resolve(process.cwd(), "uploads");
export const maxFileSize = 100 * 1024 * 1024;
export const fileLifetimeMs = 60 * 60 * 1000;

export async function ensureUploadDirectory(): Promise<void> {
  await fs.mkdir(uploadDirectory, { recursive: true });
}

export async function removeStoredFile(fileId: string): Promise<boolean> {
  const storedFile = files.get(fileId);
  if (!storedFile) return false;

  files.delete(fileId);
  try {
    await fs.unlink(storedFile.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  console.log("File deleted", { fileId, deviceId: storedFile.deviceId });
  return true;
}

export async function removeExpiredFiles(): Promise<void> {
  const cutoff = Date.now() - fileLifetimeMs;
  const expiredIds = [...files.values()]
    .filter((file) => file.createdAt.getTime() < cutoff)
    .map((file) => file.id);

  await Promise.all(expiredIds.map((fileId) => removeStoredFile(fileId)));
}
