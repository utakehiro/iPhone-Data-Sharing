const DEFAULTS = {
  deviceName: "My Windows PC",
  serverBaseUrl: "http://localhost:3000",
  connectionStatus: "disconnected",
  pendingDownloads: {},
};

let socket = null;
let socketDeviceId = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let deviceIdPromise = null;
const processingFileIds = new Set();
let downloadQueue = Promise.resolve();

async function getOrCreateDeviceId() {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      const stored = await chrome.storage.local.get("deviceId");
      if (stored.deviceId) return stored.deviceId;

      const deviceId = crypto.randomUUID();
      await chrome.storage.local.set({ deviceId });
      return deviceId;
    })();
  }
  return deviceIdPromise;
}

async function getSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  settings.deviceId = await getOrCreateDeviceId();
  return settings;
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

function safeDownloadName(value) {
  const name = String(value || "shared-file")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .trim();
  return name.slice(0, 180) || "shared-file";
}

async function registerDevice(settings) {
  const response = await fetch(`${normalizeBaseUrl(settings.serverBaseUrl)}/api/devices/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
    }),
  });
  if (!response.ok) throw new Error(`Device registration failed (${response.status})`);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(5000 * 2 ** reconnectAttempts, 30000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(connect, delay);
}

async function setStatus(status, error = "") {
  await chrome.storage.local.set({ connectionStatus: status, connectionError: error });
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  try {
    await setStatus("connecting");
    const settings = await getSettings();
    await registerDevice(settings);
    const wsBase = normalizeBaseUrl(settings.serverBaseUrl).replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const currentSocket = new WebSocket(`${wsBase}/ws?deviceId=${encodeURIComponent(settings.deviceId)}`);
    socket = currentSocket;
    socketDeviceId = settings.deviceId;

    currentSocket.onopen = async () => {
      if (socket !== currentSocket) return;
      reconnectAttempts = 0;
      await setStatus("connected");
    };
    currentSocket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "file_available") {
          downloadQueue = downloadQueue
            .then(() => downloadFile(message))
            .catch((error) => console.error("Download queue failed", error));
        }
        if (message.type === "ping" && currentSocket.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        }
      } catch (error) {
        console.error("Invalid WebSocket message", error);
      }
    };
    currentSocket.onclose = async () => {
      if (socket !== currentSocket) return;
      socket = null;
      socketDeviceId = null;
      await setStatus("disconnected");
      scheduleReconnect();
    };
    currentSocket.onerror = () => {
      currentSocket.close();
    };
  } catch (error) {
    socket = null;
    await setStatus("disconnected", error.message);
    scheduleReconnect();
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

async function downloadFile(file) {
  if (typeof file?.fileId !== "string" || !file.fileId) return;
  const settings = await getSettings();
  const history = await chrome.storage.local.get({ processedFileIds: {} });
  const cutoff = Date.now() - 60 * 60 * 1000;
  history.processedFileIds = Object.fromEntries(
    Object.entries(history.processedFileIds).filter(([, timestamp]) => timestamp > cutoff),
  );
  if (processingFileIds.has(file.fileId) || history.processedFileIds[file.fileId]) return;
  processingFileIds.add(file.fileId);

  try {
    await chrome.notifications.create(`iphone-share-${file.fileId}`, {
      type: "basic",
      iconUrl: "icons/icon.svg",
      title: "iPhoneからファイルを受信しました",
      message: `${file.filename}\n${formatBytes(file.size)}`,
    });
  } catch (error) {
    console.warn("Notification failed", error);
  }

  const url = `${normalizeBaseUrl(settings.serverBaseUrl)}/api/files/${encodeURIComponent(file.fileId)}`;
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: safeDownloadName(file.filename),
      conflictAction: "uniquify",
      saveAs: false,
    });
    const stored = await chrome.storage.local.get({ pendingDownloads: {} });
    stored.pendingDownloads[String(downloadId)] = {
      fileId: file.fileId,
      serverBaseUrl: normalizeBaseUrl(settings.serverBaseUrl),
      filename: safeDownloadName(file.filename),
      size: Number(file.size) || 0,
    };
    history.processedFileIds[file.fileId] = Date.now();
    await chrome.storage.local.set({
      pendingDownloads: stored.pendingDownloads,
      processedFileIds: history.processedFileIds,
    });
  } catch (error) {
    console.error("Download failed", error);
  } finally {
    processingFileIds.delete(file.fileId);
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || (delta.state.current !== "complete" && delta.state.current !== "interrupted")) return;
  const stored = await chrome.storage.local.get({ pendingDownloads: {} });
  const pending = stored.pendingDownloads[String(delta.id)];
  if (!pending) return;

  if (delta.state.current === "complete") {
    try {
      await fetch(`${pending.serverBaseUrl}/api/files/${encodeURIComponent(pending.fileId)}`, { method: "DELETE" });
    } catch (error) {
      console.warn("Server cleanup failed; hourly cleanup will retry", error);
    }
  } else {
    const history = await chrome.storage.local.get({ processedFileIds: {} });
    delete history.processedFileIds[pending.fileId];
    await chrome.storage.local.set({ processedFileIds: history.processedFileIds });
    if (delta.error?.current !== "USER_CANCELED") {
      setTimeout(() => downloadFile(pending), 1000);
    }
  }
  delete stored.pendingDownloads[String(delta.id)];
  await chrome.storage.local.set({ pendingDownloads: stored.pendingDownloads });
});

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.alarms.create("keep-connected", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keep-connected") connect();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "reconnect") {
    if (socket) socket.close(1000, "Settings changed");
    socket = null;
    socketDeviceId = null;
    reconnectAttempts = 0;
    connect().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.type === "get-status") {
    getSettings().then(sendResponse);
    return true;
  }
  if (message.type === "ensure-connection") {
    (async () => {
      try {
        const settings = await getSettings();
        await registerDevice(settings);
        if (socket && socketDeviceId !== settings.deviceId) {
          socket.close(1000, "Device ID changed");
          socket = null;
          socketDeviceId = null;
        }
        if (!socket || socket.readyState !== WebSocket.OPEN) await connect();
        sendResponse({ success: true });
      } catch (error) {
        await setStatus("disconnected", error.message);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  return false;
});

connect();
