import "dotenv/config";
import http from "node:http";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { WebSocketServer } from "ws";
import { createDevicesRouter } from "./routes/devices.js";
import { createFilesRouter } from "./routes/files.js";
import { createUploadRouter, notifyFile } from "./routes/upload.js";
import { connections, devices, files } from "./state.js";
import { ensureUploadDirectory, removeExpiredFiles } from "./storage/files.js";

const port = Number(process.env.PORT ?? 3000);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const shortcutUrl = process.env.IOS_SHORTCUT_URL ?? "";
const webDirectory = path.resolve(process.cwd(), "../web");

await ensureUploadDirectory();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});
app.get("/api/config", (_req, res) => {
  res.json({ publicBaseUrl, shortcutUrl });
});
app.use("/api/devices", createDevicesRouter(publicBaseUrl));
app.use("/api/upload", createUploadRouter());
app.use("/api/files", createFilesRouter());
app.use(express.static(webDirectory));
app.get("/setup", (_req, res) => res.sendFile(path.join(webDirectory, "setup.html")));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "File too large" });
    return;
  }
  res.status(500).json({ error: "Upload failed" });
});

const server = http.createServer(app);
const webSocketServer = new WebSocketServer({ server, path: "/ws" });

webSocketServer.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url ?? "", publicBaseUrl);
  const deviceId = requestUrl.searchParams.get("deviceId") ?? "";
  if (!devices.has(deviceId)) {
    socket.close(1008, "Unknown device");
    return;
  }

  const previous = connections.get(deviceId);
  if (previous && previous !== socket) previous.close(1000, "Replaced by a new connection");
  connections.set(deviceId, socket);
  console.log("WebSocket connected", { deviceId });

  for (const storedFile of files.values()) {
    if (storedFile.deviceId === deviceId) notifyFile(storedFile);
  }

  socket.on("close", () => {
    if (connections.get(deviceId) === socket) connections.delete(deviceId);
    console.log("WebSocket disconnected", { deviceId });
  });
  socket.on("error", (error) => console.error("WebSocket error", { deviceId, error }));
});

const cleanupTimer = setInterval(() => {
  removeExpiredFiles().catch((error) => console.error("File cleanup failed", error));
}, 5 * 60 * 1000);
cleanupTimer.unref();

const heartbeatTimer = setInterval(() => {
  const message = JSON.stringify({ type: "ping", timestamp: Date.now() });
  for (const socket of connections.values()) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
}, 20 * 1000);
heartbeatTimer.unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`iPhone Data Sharing server listening on http://localhost:${port}`);
  console.log(`Public setup URL: ${publicBaseUrl}`);
});
