import assert from "node:assert/strict";
import { WebSocket } from "ws";

const baseUrl = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000";
const deviceId = crypto.randomUUID();

async function json(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

const health = await json("/api/health");
assert.equal(health.response.status, 200);
assert.equal(health.body.ok, true);

const unknown = await json(`/api/devices/${crypto.randomUUID()}`);
assert.equal(unknown.response.status, 404);
assert.equal(unknown.body.error, "Unknown device");

const registration = await json("/api/devices/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ deviceId, deviceName: "Integration Test PC" }),
});
assert.equal(registration.response.status, 200);
assert.equal(registration.body.success, true);

const offlineForm = new FormData();
offlineForm.append("deviceId", deviceId);
offlineForm.append("file", new Blob(["offline"]), "offline.txt");
const offline = await json("/api/upload", { method: "POST", body: offlineForm });
assert.equal(offline.response.status, 201);
assert.equal(offline.body.queued, true);

const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?deviceId=${encodeURIComponent(deviceId)}`;
const socket = new WebSocket(wsUrl);
const queuedMessage = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Queued message timeout")), 3000);
  socket.once("message", (data) => {
    clearTimeout(timer);
    resolve(JSON.parse(data.toString()));
  });
});
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
const queuedNotice = await queuedMessage;
assert.equal(queuedNotice.filename, "offline.txt");
const queuedDownload = await fetch(`${baseUrl}/api/files/${queuedNotice.fileId}`);
assert.equal(await queuedDownload.text(), "offline");
await fetch(`${baseUrl}/api/files/${queuedNotice.fileId}`, { method: "DELETE" });

const online = await json(`/api/devices/${deviceId}`);
assert.equal(online.body.online, true);
assert.equal(online.body.deviceName, "Integration Test PC");

function nextMessage() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), 3000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function nextMessages(count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => reject(new Error("WebSocket messages timeout")), 3000);
    const listener = (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length === count) {
        clearTimeout(timer);
        socket.off("message", listener);
        resolve(messages);
      }
    };
    socket.on("message", listener);
  });
}

const multipartMessages = nextMessages(2);
const form = new FormData();
form.append("deviceId", deviceId);
form.append("file", new Blob(["Hello from integration test!"], { type: "text/plain" }), "hello.txt");
form.append("file", new Blob(["Second file"], { type: "text/plain" }), "second.txt");
const uploaded = await json("/api/upload", { method: "POST", body: form });
assert.equal(uploaded.response.status, 201);
assert.equal(uploaded.body.files.length, 2);
const notices = await multipartMessages;
const firstNotice = notices.find((notice) => notice.filename === "hello.txt");
assert.ok(firstNotice);
assert.equal(firstNotice.type, "file_available");

const downloaded = await fetch(`${baseUrl}/api/files/${firstNotice.fileId}`);
assert.equal(downloaded.status, 200);
assert.equal(await downloaded.text(), "Hello from integration test!");
assert.match(downloaded.headers.get("content-disposition") ?? "", /hello\.txt/);

const deleted = await json(`/api/files/${firstNotice.fileId}`, { method: "DELETE" });
assert.equal(deleted.response.status, 200);
const missing = await json(`/api/files/${firstNotice.fileId}`);
assert.equal(missing.response.status, 404);
const secondNotice = notices.find((notice) => notice.filename === "second.txt");
assert.ok(secondNotice);
const secondDownload = await fetch(`${baseUrl}/api/files/${secondNotice.fileId}`);
assert.equal(await secondDownload.text(), "Second file");
await fetch(`${baseUrl}/api/files/${secondNotice.fileId}`, { method: "DELETE" });

const rawMessage = nextMessage();
const raw = await json(`/api/upload/${deviceId}`, {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream", "X-Filename": "shortcut.txt" },
  body: "Hello from Shortcut!",
});
assert.equal(raw.response.status, 201);
const rawNotice = await rawMessage;
assert.equal(rawNotice.filename, "shortcut.txt");
const rawDownload = await fetch(`${baseUrl}/api/files/${rawNotice.fileId}`);
assert.equal(await rawDownload.text(), "Hello from Shortcut!");
await fetch(`${baseUrl}/api/files/${rawNotice.fileId}`, { method: "DELETE" });

const malformedNameMessage = nextMessage();
const malformedName = await json(`/api/upload/${deviceId}`, {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream", "X-Filename": "bad%ZZname?.txt" },
  body: "safe filename",
});
assert.equal(malformedName.response.status, 201);
const malformedNameNotice = await malformedNameMessage;
assert.equal(malformedNameNotice.filename, "bad%ZZname_.txt");
await fetch(`${baseUrl}/api/files/${malformedNameNotice.fileId}`, { method: "DELETE" });

const qr = await fetch(`${baseUrl}/api/devices/${deviceId}/qr`);
assert.equal(qr.status, 200);
assert.equal(qr.headers.get("content-type"), "image/png");
const signature = new Uint8Array(await qr.arrayBuffer()).slice(0, 8);
assert.deepEqual([...signature], [137, 80, 78, 71, 13, 10, 26, 10]);

socket.close();
console.log("Integration test passed");
