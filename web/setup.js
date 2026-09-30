const params = new URLSearchParams(location.search);
const deviceId = params.get("deviceId") || "";
let device;

function showStep(stepNumber) {
  document.querySelectorAll(".step").forEach((element) => element.classList.remove("active"));
  document.querySelectorAll(".progress-dot").forEach((dot, index) => {
    dot.classList.toggle("active", index < stepNumber);
  });
  document.querySelector(`#step-${stepNumber}`).classList.add("active");
}

function showError(message) {
  document.querySelectorAll(".step").forEach((element) => element.classList.remove("active"));
  document.querySelector(".progress").classList.add("hidden");
  document.querySelector("#error-message").textContent = message;
  document.querySelector("#error").classList.add("active");
}

async function loadSetup() {
  if (!deviceId) {
    showError("Device IDがありません。PC側のQRコードをもう一度読み取ってください。");
    return;
  }

  try {
    const [deviceResponse, configResponse] = await Promise.all([
      fetch(`/api/devices/${encodeURIComponent(deviceId)}`),
      fetch("/api/config"),
    ]);
    if (!deviceResponse.ok) throw new Error("Unknown device");
    device = await deviceResponse.json();
    const config = await configResponse.json();
    document.querySelectorAll(".device-name").forEach((element) => {
      element.textContent = device.deviceName;
    });

    const shortcutLink = document.querySelector("#shortcut-link");
    if (config.shortcutUrl) {
      shortcutLink.href = config.shortcutUrl;
    } else {
      shortcutLink.classList.add("disabled");
      shortcutLink.addEventListener("click", (event) => event.preventDefault());
      document.querySelector("#shortcut-missing").classList.remove("hidden");
    }
    showStep(1);
  } catch (error) {
    showError(error.message === "Unknown device" ? "Unknown device" : "端末情報を取得できませんでした。ネットワーク接続を確認してください。");
  }
}

document.querySelectorAll("[data-next]").forEach((button) => {
  button.addEventListener("click", () => showStep(Number(button.dataset.next)));
});

document.querySelector("#copy-device-id").addEventListener("click", async () => {
  const result = document.querySelector("#copy-result");
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(deviceId);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = deviceId;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      if (!document.execCommand("copy")) throw new Error("Copy failed");
      textarea.remove();
    }
    result.textContent = "Device IDをコピーしました。";
    result.classList.add("success-text");
  } catch {
    result.textContent = `コピーできませんでした。長押ししてコピーしてください: ${deviceId}`;
  }
});

document.querySelector("#test-send").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const result = document.querySelector("#test-result");
  button.disabled = true;
  button.textContent = "送信中…";
  result.textContent = "";

  const form = new FormData();
  form.append("deviceId", deviceId);
  form.append("file", new Blob(["Hello from iPhone!\n"], { type: "text/plain" }), "hello-from-iphone.txt");
  try {
    const response = await fetch("/api/upload", { method: "POST", body: form });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Upload failed");
    result.textContent = body.queued
      ? "ファイルを一時保管しました。MacでChrome拡張を開くと自動的にダウンロードされます。"
      : "送信しました。MacのDownloadsフォルダを確認してください。";
    result.classList.add("success-text");
  } catch (error) {
    result.textContent = error.message || "Upload failed";
  } finally {
    button.disabled = false;
    button.textContent = "もう一度テスト送信";
  }
});

loadSetup();
