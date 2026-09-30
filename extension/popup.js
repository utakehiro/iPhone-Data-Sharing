let settings;

async function load() {
  await chrome.runtime.sendMessage({ type: "ensure-connection" });
  settings = await chrome.runtime.sendMessage({ type: "get-status" });
  render();
}

function render() {
  document.querySelector("#device-name").value = settings.deviceName;
  document.querySelector("#server-url").value = settings.serverBaseUrl;
  document.querySelector("#device-id").textContent = settings.deviceId;
  const status = document.querySelector("#status");
  const label = settings.connectionStatus === "connected"
    ? "Connected"
    : settings.connectionStatus === "connecting" ? "Connecting…" : "Disconnected";
  status.className = `status ${settings.connectionStatus}`;
  status.querySelector("b").textContent = label;
  document.querySelector("#status-copy").textContent = settings.connectionStatus === "connected"
    ? "iPhoneからファイルを送信できます。"
    : settings.connectionError || "サーバーを起動して接続してください。";
}

async function save(changes, message) {
  await chrome.storage.local.set(changes);
  Object.assign(settings, changes);
  document.querySelector("#message").textContent = message;
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(load, 500);
}

document.querySelector("#save-name").addEventListener("click", async () => {
  const deviceName = document.querySelector("#device-name").value.trim();
  if (!deviceName) return;
  await save({ deviceName }, "端末名を保存しました。");
});

document.querySelector("#save-server").addEventListener("click", async () => {
  const serverBaseUrl = document.querySelector("#server-url").value.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(serverBaseUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error();
  } catch {
    document.querySelector("#message").textContent = "http:// または https:// のURLを入力してください。";
    return;
  }
  document.querySelector("#qr-panel").classList.add("hidden");
  await save({ serverBaseUrl }, "接続先を保存しました。");
});

document.querySelector("#show-qr").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const panel = document.querySelector("#qr-panel");
  const image = document.querySelector("#qr-image");
  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }

  button.disabled = true;
  button.textContent = "QRコードを準備中…";
  document.querySelector("#message").textContent = "";
  try {
    const ensured = await chrome.runtime.sendMessage({ type: "ensure-connection" });
    if (!ensured.success) throw new Error(ensured.error || "サーバーに接続できません");
    settings = await chrome.runtime.sendMessage({ type: "get-status" });
    const qrUrl = `${settings.serverBaseUrl.replace(/\/$/, "")}/api/devices/${encodeURIComponent(settings.deviceId)}/qr?t=${Date.now()}`;
    const response = await fetch(qrUrl, { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `QRコードを取得できません (${response.status})`);
    }
    image.src = qrUrl;
    panel.classList.remove("hidden");
  } catch (error) {
    panel.classList.add("hidden");
    document.querySelector("#message").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "QRコードを表示";
  }
});

document.querySelector("#copy-id").addEventListener("click", async () => {
  await navigator.clipboard.writeText(settings.deviceId);
  document.querySelector("#message").textContent = "Device IDをコピーしました。";
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !settings) return;
  for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
  render();
});

load();
