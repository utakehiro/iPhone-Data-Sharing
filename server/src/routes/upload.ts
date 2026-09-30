import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Router, type Request } from "express";
import multer from "multer";
import { WebSocket } from "ws";
import { connections, devices, files } from "../state.js";
import { maxFileSize, uploadDirectory } from "../storage/files.js";
import type { StoredFile } from "../types.js";

function safeName(value: string): string {
  const basename = path.basename(value).replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  return basename.slice(0, 180) || "shared-file";
}

function decodedHeaderFilename(value: unknown): string {
  const raw = String(value ?? "shared-file");
  try { return decodeURIComponent(raw); }
  catch { return raw; }
}

const storage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (_request, file, callback) => {
    callback(null, `${randomUUID()}${path.extname(file.originalname).slice(0, 16)}`);
  },
});

const multipartUpload = multer({
  storage,
  limits: { fileSize: maxFileSize, files: 50 },
});

export function notifyFile(storedFile: StoredFile): boolean {
  const socket = connections.get(storedFile.deviceId);
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;

  socket.send(JSON.stringify({
    type: "file_available",
    fileId: storedFile.id,
    filename: storedFile.originalName,
    mimeType: storedFile.mimeType,
    size: storedFile.size,
  }));
  console.log("File notification sent", {
    deviceId: storedFile.deviceId,
    fileId: storedFile.id,
  });
  return true;
}

function checkDevice(deviceId: string, request: Request): string | null {
  if (!devices.has(deviceId)) return "Unknown device";
  if (!request.is("multipart/form-data") && !request.is("application/octet-stream") && !request.is("*/*")) {
    return "Unsupported content type";
  }
  return null;
}

export function createUploadRouter(): Router {
  const router = Router();

  router.post("/", multipartUpload.array("file"), async (req, res) => {
    const deviceId = typeof req.body.deviceId === "string" ? req.body.deviceId : "";
    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    const validationError = checkDevice(deviceId, req);

    if (validationError || uploadedFiles.length === 0) {
      await Promise.all(uploadedFiles.map((file) => fs.unlink(file.path).catch(() => undefined)));
      res.status(400).json({
        error: validationError ?? "No files uploaded",
      });
      return;
    }

    const responseFiles = uploadedFiles.map((file) => {
      const id = randomUUID();
      const storedFile: StoredFile = {
        id,
        deviceId,
        originalName: safeName(file.originalname),
        mimeType: file.mimetype || "application/octet-stream",
        size: file.size,
        path: file.path,
        createdAt: new Date(),
      };
      files.set(id, storedFile);
      console.log("File uploaded", { deviceId, fileId: id, size: file.size });
      notifyFile(storedFile);
      return { fileId: id, filename: storedFile.originalName };
    });

    res.status(201).json({ success: true, queued: !connections.has(deviceId), files: responseFiles });
  });

  router.post(
    "/:deviceId",
    multer({
      storage,
      limits: { fileSize: maxFileSize, files: 1 },
    }).single("file"),
    async (req, res, next) => {
      try {
        const deviceId = String(req.params.deviceId);
        const validationError = !devices.has(deviceId) ? "Unknown device" : null;
        if (validationError) {
          if (req.file) await fs.unlink(req.file.path).catch(() => undefined);
          res.status(404).json({ error: validationError });
          return;
        }

        let diskPath: string;
        let size: number;
        let originalName: string;
        let mimeType: string;

        if (req.file) {
          diskPath = req.file.path;
          size = req.file.size;
          originalName = safeName(req.file.originalname);
          mimeType = req.file.mimetype || "application/octet-stream";
        } else {
          const contentLength = Number(req.headers["content-length"] ?? 0);
          if (contentLength > maxFileSize) {
            res.status(413).json({ error: "File too large" });
            return;
          }
          const idForPath = randomUUID();
          diskPath = path.join(uploadDirectory, idForPath);
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of req) {
            const buffer = Buffer.from(chunk);
            total += buffer.length;
            if (total > maxFileSize) {
              res.status(413).json({ error: "File too large" });
              return;
            }
            chunks.push(buffer);
          }
          if (total === 0) {
            res.status(400).json({ error: "No file uploaded" });
            return;
          }
          await fs.writeFile(diskPath, Buffer.concat(chunks));
          size = total;
          originalName = safeName(decodedHeaderFilename(req.headers["x-filename"]));
          mimeType = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0];
        }

        const id = randomUUID();
        const storedFile: StoredFile = {
          id,
          deviceId,
          originalName,
          mimeType,
          size,
          path: diskPath,
          createdAt: new Date(),
        };
        files.set(id, storedFile);
        console.log("File uploaded", { deviceId, fileId: id, size });
        notifyFile(storedFile);
        res.status(201).json({
          success: true,
          queued: !connections.has(deviceId),
          files: [{ fileId: id, filename: originalName }],
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
