import path from "node:path";
import { Router } from "express";
import { files } from "../state.js";
import { removeStoredFile } from "../storage/files.js";

function asciiFallback(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return fallback || "download";
}

export function createFilesRouter(): Router {
  const router = Router();

  router.get("/:fileId", (req, res) => {
    const storedFile = files.get(req.params.fileId);
    if (!storedFile) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const encodedName = encodeURIComponent(storedFile.originalName);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiFallback(storedFile.originalName)}"; filename*=UTF-8''${encodedName}`,
    );
    res.type(storedFile.mimeType);
    console.log("File downloaded", { fileId: storedFile.id, deviceId: storedFile.deviceId });
    res.sendFile(path.resolve(storedFile.path), (error) => {
      if (error && !res.headersSent) {
        res.status(500).json({ error: "Download failed" });
      }
    });
  });

  router.delete("/:fileId", async (req, res, next) => {
    try {
      const removed = await removeStoredFile(req.params.fileId);
      if (!removed) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
