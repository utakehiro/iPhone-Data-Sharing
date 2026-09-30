import "dotenv/config";
import { randomBytes, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { spawn } from "node:child_process";
import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import QRCode from "qrcode";

const port = Number(process.env.PORT ?? 3000);
const hostPlatform = process.env.HOST_PLATFORM?.toLowerCase() === "windows" ? "windows" : "mac";
const isWindowsHost = hostPlatform === "windows";
const defaultDataDirectory =
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "iPhone Data Sharing")
    : path.join(os.homedir(), ".iphone-share-agent");
let downloads = path.resolve(process.env.DOWNLOAD_DIR ?? path.join(os.homedir(), "Downloads", "iPhone Data Sharing"));
const scratch = path.resolve(process.env.TEMP_DIR ?? path.join(os.tmpdir(), "iphone-share-agent"));
const dataDirectory = path.resolve(process.env.DATA_DIR ?? defaultDataDirectory);
const staticShortcutDirectory = process.env.STATIC_SHORTCUT_DIR?.trim()
  ? path.resolve(process.env.STATIC_SHORTCUT_DIR)
  : "";
const sessionFile = path.join(dataDirectory, "sessions.json");
const downloadPreferenceFile = path.join(dataDirectory, "download-directory.json");
const generatedDirectory = path.join(dataDirectory, "generated");
const outboxDirectory = path.join(dataDirectory, "outbox");
const outboxFile = path.join(dataDirectory, "outbox.json");
const homeScreenFile = path.join(dataDirectory, "home-screen.json");
const licenseFile = path.join(dataDirectory, "license.json");
const usageFile = path.join(dataDirectory, "usage.json");
const shortcutDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../shortcuts");
const shortcutBuilder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../tools/build_shortcuts.py");
const iconCandidates = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../AppIcon.png"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mac-agent/assets/AppIcon.png"),
];
const lanAddress = Object.entries(os.networkInterfaces())
  .flatMap(([name, addresses]) => (addresses ?? []).filter((item) => item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254.")).map((item) => ({ name, address: item.address })))
  .sort((a, b) => {
    const score = (item: { name: string; address: string }): number =>
      (/^(en\d+|Wi-Fi|Ethernet)$/i.test(item.name) ? 100 : 0) +
      (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address) ? 50 : 0) -
      (/^(utun|tun|tap|vmnet|vbox|docker|bridge)/i.test(item.name) ? 200 : 0);
    return score(b) - score(a);
  })[0]?.address;
const configuredBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
const baseUrl = configuredBaseUrl ?? (lanAddress ? `http://${lanAddress}:${port}` : "");
const pairingLifetime = 5 * 60_000;
const outboxLifetime = 7 * 24 * 60 * 60_000;
const sessionLifetime = 365 * 24 * 60 * 60_000;
const maxFileSize = 100 * 1024 * 1024;
const freeDailyLimit = 10;
// Development activation is opt-in. Production builds should use the configured
// license provider instead of embedding a key in the application package.
const developmentLicenseKey = process.env.DEVELOPMENT_LICENSE_KEY?.trim() ?? "";
const proPurchaseUrl = process.env.PRO_PURCHASE_URL?.trim() || "";
const pairing = new Map<string, number>();
type Session = { expiry: number; deviceId: string };
const sessions = new Map<string, Session>();
const configuredShortcuts = new Map<string, string>();
const shortcutRevision = "2026-09-23-windows-static-shortcuts";
type OutboxItem = { id: string; deviceId: string; name: string; imageType?: string; created: number; expires: number; status: "queued" | "downloaded" | "acked" | "expired" | "failed" };
const outbox = new Map<string, OutboxItem>();
const homeScreenDevices = new Set<string>();
const listeners = new Map<Response, string>();
function announce(device: string): void {
  for (const [res, id] of listeners) if (device === id) res.write("event: update\ndata: {}\n\n");
}
let receivedCount = 0;

type LicenseState = {
  plan: "free" | "pro";
  provider?: "development" | "cloudflare";
  keyHash?: string;
  activatedAt?: string;
};
type UsageState = { day: string; count: number };
type UsageReservation = { day: string; amount: number; active: boolean };
type TransferPermit = {
  deviceId: string;
  expires: number;
};

let licenseState: LicenseState = { plan: "free" };
let usageState: UsageState = { day: "", count: 0 };
const transferPermits = new Map<string, TransferPermit>();
let pendingUsageMutation: Promise<void> = Promise.resolve();

await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
try {
  const saved = JSON.parse(await fs.readFile(downloadPreferenceFile, "utf8")) as { directory?: string };
  if (saved.directory && path.isAbsolute(saved.directory) && (await fs.stat(saved.directory)).isDirectory()) downloads = saved.directory;
} catch { /* Keep the initial download directory if the preference is absent or no longer valid. */ }
await Promise.all([fs.mkdir(downloads, { recursive: true }), fs.mkdir(scratch, { recursive: true }), fs.mkdir(generatedDirectory, { recursive: true, mode: 0o700 }), fs.mkdir(outboxDirectory, { recursive: true, mode: 0o700 })]);
try {
  const stored = JSON.parse(await fs.readFile(outboxFile, "utf8")) as OutboxItem[];
  for (const item of stored) if (/^[A-Za-z0-9_-]{43}$/.test(item.id) && /^[0-9a-f]{64}$/.test(item.deviceId)) outbox.set(item.id, item);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
try {
  const stored = JSON.parse(await fs.readFile(homeScreenFile, "utf8")) as string[];
  for (const id of stored) if (/^[0-9a-f]{64}$/.test(id)) homeScreenDevices.add(id);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
try {
  const stored = JSON.parse(await fs.readFile(licenseFile, "utf8")) as LicenseState;
  if (stored.plan === "pro" && (stored.provider === "development" || stored.provider === "cloudflare")) {
    licenseState = stored;
  }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
try {
  const stored = JSON.parse(await fs.readFile(usageFile, "utf8")) as UsageState;
  if (typeof stored.day === "string" && Number.isInteger(stored.count) && stored.count >= 0) {
    usageState = stored;
  }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
// Recreate signed downloads on demand after restart; remove credentials left in the old process.
await Promise.all(
  (await fs.readdir(generatedDirectory))
    .filter((name) => /^[0-9a-f]{64}(?:-(?:send|receive))?\.shortcut(?:\.manifest\.json)?$/.test(name))
    .map((name) => fs.unlink(path.join(generatedDirectory, name))),
);
try {
  const stored = JSON.parse(await fs.readFile(sessionFile, "utf8")) as Record<string, number | Session>;
  for (const [key, value] of Object.entries(stored)) {
    const session = typeof value === "number" ? { expiry: value, deviceId: key } : value;
    if (/^[0-9a-f]{64}$/.test(key) && /^[0-9a-f]{64}$/.test(session.deviceId) && Number.isFinite(session.expiry) && session.expiry > Date.now()) sessions.set(key, session);
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
let pendingSave: Promise<void> = Promise.resolve();
let pendingOutboxSave: Promise<void> = Promise.resolve();
function saveOutbox(): Promise<void> {
  const contents = JSON.stringify([...outbox.values()]);
  pendingOutboxSave = pendingOutboxSave.then(async () => {
    const staging = path.join(dataDirectory, `outbox-${token()}.tmp`);
    await fs.writeFile(staging, contents, { mode: 0o600 });
    await fs.rename(staging, outboxFile);
  });
  return pendingOutboxSave;
}
async function saveHomeScreen(): Promise<void> {
  const staging = path.join(dataDirectory, `home-screen-${token()}.tmp`);
  await fs.writeFile(staging, JSON.stringify([...homeScreenDevices]), { mode: 0o600 });
  await fs.rename(staging, homeScreenFile);
}
function saveSessions(): Promise<void> {
  const contents = JSON.stringify(Object.fromEntries(sessions));
  pendingSave = pendingSave.then(async () => {
    const staging = path.join(dataDirectory, `sessions-${token()}.tmp`);
    await fs.writeFile(staging, contents, { mode: 0o600 });
    await fs.rename(staging, sessionFile);
  });
  return pendingSave;
}
async function atomicJsonWrite(file: string, value: unknown): Promise<void> {
  const staging = path.join(dataDirectory, `${path.basename(file)}-${token()}.tmp`);
  await fs.writeFile(staging, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(staging, file);
}
function localDayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function currentUsage(): UsageState {
  const day = localDayKey();
  return usageState.day === day ? usageState : { day, count: 0 };
}
function licenseSummary() {
  const usage = currentUsage();
  const pro = licenseState.plan === "pro";
  return {
    plan: pro ? "pro" : "free",
    active: pro,
    provider: licenseState.provider ?? null,
    activatedAt: licenseState.activatedAt ?? null,
    dailyLimit: pro ? null : freeDailyLimit,
    usedToday: usage.count,
    remainingToday: pro ? null : Math.max(0, freeDailyLimit - usage.count),
    unit: "file",
  };
}
function proRequiredPayload(lang: UiLang = "ja") {
  return {
    code: "PRO_REQUIRED",
    error: tr(lang,
      `無料版は1日${freeDailyLimit}ファイル（送受信計）までです。本日の上限に達しました。PRO版にアップデートすると無制限で利用できます。`,
      `The Free plan allows up to ${freeDailyLimit} files per day in total (sent + received). You have reached today's limit. Upgrade to PRO for unlimited local transfers.`
    ),
    upgradeUrl: "/pro",
    purchaseUrl: proPurchaseUrl || null,
  };
}
async function mutateUsage<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = pendingUsageMutation;
  pendingUsageMutation = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await fn(); }
  finally { release(); }
}
async function reserveUsage(amount = 1): Promise<UsageReservation | null> {
  const normalized = Math.max(1, Math.floor(amount));
  if (licenseState.plan === "pro") return { day: localDayKey(), amount: normalized, active: false };
  return mutateUsage(async () => {
    const day = localDayKey();
    if (usageState.day !== day) usageState = { day, count: 0 };
    if (usageState.count + normalized > freeDailyLimit) return null;
    usageState.count += normalized;
    await atomicJsonWrite(usageFile, usageState);
    return { day, amount: normalized, active: true };
  });
}
async function releaseUsage(reservation: UsageReservation | undefined): Promise<void> {
  if (!reservation?.active) return;
  await mutateUsage(async () => {
    if (usageState.day === reservation.day && usageState.count > 0) {
      usageState.count = Math.max(0, usageState.count - reservation.amount);
      await atomicJsonWrite(usageFile, usageState);
    }
    reservation.active = false;
  });
}
async function activateLicenseKey(value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = value.trim();
  // Development validator. Later, replace this branch with a Cloudflare API
  // verification call fed by Creem-issued license entitlements.
  if (!developmentLicenseKey || key !== developmentLicenseKey) {
    return { ok: false, error: "ライセンスキーを確認できません。入力内容を確認してください。" };
  }
  licenseState = {
    plan: "pro",
    provider: "development",
    keyHash: digest(key),
    activatedAt: new Date().toISOString(),
  };
  await atomicJsonWrite(licenseFile, licenseState);
  return { ok: true };
}
async function deactivateLicense(): Promise<void> {
  licenseState = { plan: "free" };
  await atomicJsonWrite(licenseFile, licenseState);
}

function token(): string { return randomBytes(32).toString("base64url"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function cleanName(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").pop()?.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  return (name || "file").slice(0, 180);
}
function multipartName(value: string): string {
  const utf8 = Buffer.from(value, "latin1").toString("utf8");
  return Buffer.from(utf8, "utf8").toString("latin1") === value ? utf8 : value;
}
function extensionForMime(value: string | undefined): string {
  const type = (value ?? "").split(";", 1)[0].trim().toLowerCase();
  return new Map<string, string>([
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/gif", ".gif"],
    ["image/webp", ".webp"],
    ["image/heic", ".heic"],
    ["image/avif", ".avif"],
    ["application/pdf", ".pdf"],
    ["video/quicktime", ".mov"],
    ["video/mp4", ".mp4"],
    ["audio/mpeg", ".mp3"],
    ["audio/mp4", ".m4a"],
    ["text/plain", ".txt"],
    ["text/csv", ".csv"],
    ["application/zip", ".zip"],
  ]).get(type) ?? "";
}
function ensureExtension(name: string, contentType: string | undefined, detectedType?: string): string {
  const safe = cleanName(name);
  if (path.extname(safe)) return safe;
  const extension = extensionForMime(contentType) || extensionForMime(detectedType);
  return extension ? `${safe}${extension}` : safe;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
async function imageType(file: string): Promise<string | undefined> {
  const handle = await fs.open(file, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
    if (bytesRead >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (bytesRead >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
    if (bytesRead >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (bytesRead >= 12 && bytes.toString("ascii", 4, 8) === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(bytes.toString("ascii", 8, 12))) return "image/heic";
    if (bytesRead >= 12 && bytes.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))) return "image/avif";
    if (bytesRead >= 12 && bytes.toString("ascii", 4, 8) === "ftyp" && bytes.toString("ascii", 8, 12) === "qt  ") return "video/quicktime";
    if (bytesRead >= 12 && bytes.toString("ascii", 4, 8) === "ftyp" && ["isom", "iso2", "mp41", "mp42", "M4V ", "avc1"].includes(bytes.toString("ascii", 8, 12))) return "video/mp4";
    return undefined;
  } finally { await handle.close(); }
}
function isLocal(req: Request): boolean {
  return req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1" || req.socket.remoteAddress === "::ffff:127.0.0.1";
}
function sameOrigin(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === req.get("host"); } catch { return false; }
}
function admin(req: Request, res: Response, next: NextFunction): void {
  if (!isLocal(req) || !sameOrigin(req)) { res.status(403).json({ error: "PC上で開いてください" }); return; }
  next();
}
function sessionToken(req: Request): string | undefined {
  const bearer = req.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  const cookie = req.get("cookie")?.match(/(?:^|;\s*)iphone_share=([A-Za-z0-9_-]+)/)?.[1];
  return bearer ?? cookie;
}
function requestCredential(req: Request): string | undefined {
  const home = typeof req.query.home === "string" && /^[A-Za-z0-9_-]{43}$/.test(req.query.home) ? req.query.home : undefined;
  return sessionToken(req) ?? home;
}
function currentSession(req: Request): Session | undefined {
  const raw = requestCredential(req);
  const session = raw && sessions.get(digest(raw));
  return session && session.expiry > Date.now() ? session : undefined;
}
function deviceId(req: Request): string { return currentSession(req)!.deviceId; }
function activeDeviceId(): string | undefined { return [...sessions.values()].reverse().find((session) => session.expiry > Date.now())?.deviceId; }
function visible(item: OutboxItem, id: string): boolean { return item.deviceId === id && item.expires > Date.now() && item.status !== "acked" && item.status !== "expired"; }
function outboxResponse(item: OutboxItem) {
  const fileUrl = `/api/files/${item.id}`;
  const type = item.imageType?.startsWith("image/") ? "image" : item.imageType?.startsWith("video/") ? "video" : "file";
  return { id: item.id, name: item.name, type, status: item.status, created: item.created, fileUrl, previewUrl: item.imageType ? `/api/files/${item.id}/preview` : undefined };
}
type UiLang = "ja" | "en" | "zh" | "ko" | "es" | "fr" | "de";

const uiTranslations: Record<Exclude<UiLang, "ja" | "en">, Record<string, string>> = {"zh":{"Activate":"激活","Activate license key":"激活许可证密钥","Activate your license key from the PRO License screen on your Mac.":"请在 Mac 上的 PRO 许可证页面激活许可证密钥。","Activated":"已激活","Add files":"添加文件","Add to Home Screen":"添加到主屏幕","After saving the .shortcut file, open it from Files and choose Add Shortcut.":"保存 .shortcut 文件后，请在“文件”App 中打开并选择“添加快捷指令”。","Allow file transfers with this Mac. Files are transferred securely over the same Wi‑Fi / LAN.":"允许与此 Mac 传输文件。文件会通过同一 Wi‑Fi / 局域网安全传输。","Back to transfer":"返回传输页面","Buy PRO":"购买 PRO","Checking":"检查中","Checking usage…":"正在检查使用情况…","Checking your plan…":"正在检查方案…","Checking…":"检查中…","Choose files":"选择文件","Choose photos, files, PDFs, and other items from the iPhone share sheet and send them directly to your Mac on the same LAN. After setup, simply choose “Send to Mac” from the Share menu.":"从 iPhone 共享菜单中选择照片、文件、PDF 等，即可直接发送到同一局域网中的 Mac。完成设置后，只需在共享菜单中选择“发送到 Mac”。","Connect to this Mac":"连接此 Mac","Connect your iPhone":"连接 iPhone","Connected":"已连接","Connected to this Mac. Set up the shortcuts to continue.":"已连接到此 Mac。请设置快捷指令以继续。","Could not deactivate the license":"无法停用许可证","Could not verify the license":"无法验证许可证","Deactivate":"停用","Deactivating…":"正在停用…","Default save location:":"默认保存位置：","Downloads all pending files from your Mac and saves them to the Files app. It does not use the Photos app.":"下载 Mac 上所有待接收文件并保存到“文件”App，不会使用“照片”App。","Downloads all pending files sent from your Mac and saves them to the Files app.":"下载从 Mac 发送的所有待接收文件并保存到“文件”App。","Drag and drop files to send them to your paired iPhone.":"拖放文件即可发送到已配对的 iPhone。","Drop files here":"将文件拖到这里","Drop files on this page to put them in the receive queue.":"将文件拖到此页面即可加入接收队列。","Enter the license key issued after purchase.":"请输入购买后发放的许可证密钥。","Expired":"已过期","iPhone Data Sharing Inbox":"iPhone Data Sharing 收件箱","iPhone Data Sharing Receive":"iPhone Data Sharing 接收","Files stay local:":"文件保持在本地：","First-run permissions":"首次运行权限","From iPhone Data Sharing in the Mac menu bar, choose “Connect iPhone” again to generate a new one.":"在 Mac 菜单栏的 iPhone Data Sharing 中再次选择“连接 iPhone”即可重新生成。","Generating the shortcut may take a moment. Preparing…":"生成快捷指令可能需要一些时间。正在准备…","Get “iPhone Data Sharing Receive”":"获取“iPhone Data Sharing 接收”","Get “Send to Mac”":"获取“发送到 Mac”","Home Screen icon":"主屏幕图标","How it works":"使用流程","How to add":"添加方法","If network or file-saving permission prompts appear, choose the option that allows continued use.":"如果出现网络或文件保存权限提示，请选择允许持续使用的选项。","If you do not have the Shortcuts app,":"如果尚未安装“快捷指令”App，","In the iPhone Shortcuts app, open “iPhone Data Sharing Receive” → Share → Add to Home Screen. If you want to use an icon, you can use the iPhone Data Sharing image. You can also open the URL below directly on your iPhone.":"在 iPhone 的“快捷指令”App 中打开“iPhone Data Sharing 接收”→“共享”→“添加到主屏幕”。如需图标，可使用 iPhone Data Sharing 图片。也可在 iPhone 上直接打开下方 URL。","License":"许可证","License key":"许可证密钥","Manage inbox":"管理收件箱","New files will appear automatically.":"新文件会自动显示。","No repeated QR scanning:":"无需重复扫描二维码：","Notes":"补充说明","On iPhone, touch and hold the image to save it, then choose it as the Home Screen icon.":"在 iPhone 上长按图片保存，然后将其指定为主屏幕图标。","On your Mac, open iPhone Data Sharing → Connection & Settings → Transfer Setup, then reinstall the shortcuts if needed.":"在 Mac 上打开 iPhone Data Sharing →“连接与设置”→“传输设置”，如有需要请重新安装快捷指令。","On your paired iPhone, open the setup page below and add the shortcuts.":"在已配对的 iPhone 上打开下方设置页面并添加快捷指令。","Open the iPhone Data Sharing icon on iPhone":"在 iPhone 上打开 iPhone Data Sharing 图标","PRO License":"PRO 许可证","PRO has been deactivated.":"PRO 已停用。","PRO is active":"PRO 已启用","PRO is active. You do not need to enter the license key again.":"PRO 已启用，无需再次输入许可证密钥。","PRO is now active. Sent and received files are unlimited.":"PRO 已启用，发送和接收文件数量不限。","PRO license active":"PRO 许可证已启用","PRO purchase page coming soon":"PRO 购买页面即将上线","Pair from Connection & Settings in the menu bar.":"从菜单栏的“连接与设置”进行配对。","Preparing the receive shortcut…":"正在准备接收快捷指令…","QR code for the iPhone Data Sharing icon URL":"iPhone Data Sharing 图标 URL 二维码","QR code for the setup page URL":"设置页面 URL 二维码","Receive on iPhone":"在 iPhone 上接收","Run “iPhone Data Sharing Receive” on your iPhone to save them.":"在 iPhone 上运行“iPhone Data Sharing 接收”即可保存文件。","Safe transfer on the same LAN:":"同一局域网内安全传输：","Send files":"发送文件","Send files to your Mac on this LAN.":"将文件发送到此局域网中的 Mac。","Send from Mac to iPhone":"从 Mac 发送到 iPhone","Send from iPhone to Mac":"从 iPhone 发送到 Mac","Send multiple images, PDFs, documents, and other files at once.":"可一次发送多张图片、PDF、文档等文件。","Send to Mac":"发送到 Mac","Set up shortcuts":"设置快捷指令","Set up the shortcuts used on this iPhone. After the initial setup, you can send and receive without scanning the QR code again.":"设置此 iPhone 使用的快捷指令。首次设置后，后续收发无需再次扫描二维码。","Setup page URL":"设置页面 URL","Start Pairing":"开始配对","The pairing QR code has expired. Generate a new QR code on your Mac.":"配对二维码已过期，请在 Mac 上生成新的二维码。","The shortcut is generated with Share Sheet enabled and accepts images, media, and files.":"生成的快捷指令已启用共享菜单，并接受图片、媒体和文件。","There are no pending files right now.":"当前没有待接收文件。","There is no limit on sent or received files.":"发送和接收文件数量不限。","This local URL opens iPhone Data Sharing setup from an iPhone on the same LAN. Open it in Safari to get the “Send to Mac” and “iPhone Data Sharing Receive” shortcuts.":"此本地 URL 可从同一局域网中的 iPhone 打开 iPhone Data Sharing 设置。用 Safari 打开后可获取“发送到 Mac”和“iPhone Data Sharing 接收”快捷指令。","This page lets you review and delete pending files. For normal receiving, run the “iPhone Data Sharing Receive” shortcut on your iPhone.":"此页面用于查看和删除待接收文件。正常接收时，请在 iPhone 上运行“iPhone Data Sharing 接收”快捷指令。","This shortcut is also generated with Share Sheet enabled for images, media, and files.":"此快捷指令同样启用了共享菜单，并支持图片、媒体和文件。","Transfer Setup":"传输设置","Transfer Setup Information":"传输设置信息","Upgrade to PRO":"升级到 PRO","Use this shortcut from the iPhone share sheet to send photos, videos, and documents directly to your Mac.":"从 iPhone 共享菜单使用此快捷指令，可将照片、视频和文档直接发送到 Mac。","View pending files":"查看待接收文件","When adding “iPhone Data Sharing Receive” to the Home Screen, you can use the iPhone Data Sharing image. Open the link below on your iPhone, then touch and hold the image to save it.":"将“iPhone Data Sharing 接收”添加到主屏幕时，可以使用 iPhone Data Sharing 图片。在 iPhone 上打开下方链接，长按图片即可保存。","You can also click to choose files.":"也可以点击选择文件。","You can change it later by editing “iPhone Data Sharing Receive” in Shortcuts and changing the destination of the Save File action.":"之后可在“快捷指令”中编辑“iPhone Data Sharing 接收”，修改“存储文件”操作的保存位置。","You can change this later by editing “iPhone Data Sharing Receive” in the Shortcuts app and changing the destination of the Save File action.":"之后可在“快捷指令”App 中编辑“iPhone Data Sharing 接收”，修改“存储文件”操作的保存位置。","Your authorization needs to be refreshed.":"需要刷新授权。","install it from the App Store":"请从 App Store 安装"," Files are transferred directly within your local network.":" 文件内容直接在本地网络内传输。"," After the first pairing, normal transfers do not require another QR scan.":" 首次配对后，日常收发无需再次扫描二维码。"," File contents are not uploaded to an external cloud service.":" 文件内容不会上传到外部云服务。",".":"。","件を送信中…":" 个文件发送中…","Connect your iPhone first.":"请先连接 iPhone。","You are currently using PRO":"当前正在使用 PRO","Sent and received files are unlimited.":"发送和接收文件数量不限。","You are currently using the Free plan":"当前正在使用免费版","Today: ":"今天："," files used":" 个文件已使用"," file(s) sent to iPhone.":" 个文件已发送到 iPhone。","Run “iPhone Data Sharing Receive” on your iPhone.":"请在 iPhone 上运行“iPhone Data Sharing 接收”。","• Default save location: iCloud Drive > Shortcuts > iPhone Data Sharing":"• 默认保存位置：iCloud Drive > Shortcuts > iPhone Data Sharing","• You can change the save location inside the “iPhone Data Sharing Receive” shortcut.":"• 可在“iPhone Data Sharing 接收”快捷指令中更改保存位置。","Delete":"删除","Could not delete the file.":"无法删除文件。","Sending…":"发送中…","View PRO":"查看 PRO","Could not send the files":"无法发送文件"," file(s) saved to Mac":" 个文件已保存到 Mac","Could not connect. Make sure both devices are on the same Wi‑Fi / LAN.":"无法连接。请确认两台设备位于同一 Wi‑Fi / 局域网。"},"ko":{"Activate":"활성화","Activate license key":"라이선스 키 활성화","Activate your license key from the PRO License screen on your Mac.":"Mac의 PRO 라이선스 화면에서 라이선스 키를 활성화하세요.","Activated":"활성화됨","Add files":"파일 추가","Add to Home Screen":"홈 화면에 추가","After saving the .shortcut file, open it from Files and choose Add Shortcut.":".shortcut 파일을 저장한 뒤 파일 앱에서 열고 ‘단축어 추가’를 선택하세요.","Allow file transfers with this Mac. Files are transferred securely over the same Wi‑Fi / LAN.":"이 Mac과의 파일 전송을 허용합니다. 같은 Wi‑Fi/LAN에서 안전하게 전송됩니다.","Back to transfer":"전송 화면으로 돌아가기","Buy PRO":"PRO 구매","Checking":"확인 중","Checking usage…":"사용량 확인 중…","Checking your plan…":"요금제 확인 중…","Checking…":"확인 중…","Choose files":"파일 선택","Choose photos, files, PDFs, and other items from the iPhone share sheet and send them directly to your Mac on the same LAN. After setup, simply choose “Send to Mac” from the Share menu.":"iPhone 공유 시트에서 사진, 파일, PDF 등을 선택해 같은 LAN의 Mac으로 직접 보냅니다. 설정 후에는 공유 메뉴에서 ‘Mac으로 보내기’를 선택하면 됩니다.","Connect to this Mac":"이 Mac에 연결","Connect your iPhone":"iPhone 연결","Connected":"연결됨","Connected to this Mac. Set up the shortcuts to continue.":"이 Mac에 연결되었습니다. 계속하려면 단축어를 설정하세요.","Could not deactivate the license":"라이선스를 비활성화할 수 없습니다","Could not verify the license":"라이선스를 확인할 수 없습니다","Deactivate":"비활성화","Deactivating…":"비활성화 중…","Default save location:":"기본 저장 위치:","Downloads all pending files from your Mac and saves them to the Files app. It does not use the Photos app.":"Mac의 대기 중인 파일을 모두 받아 파일 앱에 저장합니다. 사진 앱은 사용하지 않습니다.","Downloads all pending files sent from your Mac and saves them to the Files app.":"Mac에서 보낸 대기 중인 파일을 모두 받아 파일 앱에 저장합니다.","Drag and drop files to send them to your paired iPhone.":"파일을 드래그 앤 드롭하여 페어링된 iPhone으로 보냅니다.","Drop files here":"여기에 파일을 놓으세요","Drop files on this page to put them in the receive queue.":"이 페이지에 파일을 놓으면 수신 대기열에 추가됩니다.","Enter the license key issued after purchase.":"구매 후 발급된 라이선스 키를 입력하세요.","Expired":"만료됨","iPhone Data Sharing Inbox":"iPhone Data Sharing 수신함","iPhone Data Sharing Receive":"iPhone Data Sharing 수신","Files stay local:":"파일은 로컬에 유지:","First-run permissions":"최초 실행 권한","From iPhone Data Sharing in the Mac menu bar, choose “Connect iPhone” again to generate a new one.":"Mac 메뉴 막대의 iPhone Data Sharing에서 ‘iPhone 연결’을 다시 선택해 새 QR을 생성하세요.","Generating the shortcut may take a moment. Preparing…":"단축어 생성에 잠시 걸릴 수 있습니다. 준비 중…","Get “iPhone Data Sharing Receive”":"‘iPhone Data Sharing 수신’ 받기","Get “Send to Mac”":"‘Mac으로 보내기’ 받기","Home Screen icon":"홈 화면 아이콘","How it works":"사용 방법","How to add":"추가 방법","If network or file-saving permission prompts appear, choose the option that allows continued use.":"네트워크 또는 파일 저장 권한 요청이 나타나면 계속 사용할 수 있는 옵션을 선택하세요.","If you do not have the Shortcuts app,":"단축어 앱이 없다면","In the iPhone Shortcuts app, open “iPhone Data Sharing Receive” → Share → Add to Home Screen. If you want to use an icon, you can use the iPhone Data Sharing image. You can also open the URL below directly on your iPhone.":"iPhone 단축어 앱에서 ‘iPhone Data Sharing 수신’ → 공유 → ‘홈 화면에 추가’를 선택하세요. 아이콘을 사용하려면 iPhone Data Sharing 이미지를 사용할 수 있습니다. 아래 URL도 iPhone에서 직접 열 수 있습니다.","License":"라이선스","License key":"라이선스 키","Manage inbox":"수신함 관리","New files will appear automatically.":"새 파일은 자동으로 표시됩니다.","No repeated QR scanning:":"QR 재스캔 불필요:","Notes":"참고","On iPhone, touch and hold the image to save it, then choose it as the Home Screen icon.":"iPhone에서 이미지를 길게 눌러 저장한 뒤 홈 화면 아이콘으로 지정하세요.","On your Mac, open iPhone Data Sharing → Connection & Settings → Transfer Setup, then reinstall the shortcuts if needed.":"Mac에서 iPhone Data Sharing → 연결 및 설정 → 전송 설정을 열고 필요하면 단축어를 다시 설치하세요.","On your paired iPhone, open the setup page below and add the shortcuts.":"페어링된 iPhone에서 아래 설정 페이지를 열고 단축어를 추가하세요.","Open the iPhone Data Sharing icon on iPhone":"iPhone에서 iPhone Data Sharing 아이콘 열기","PRO License":"PRO 라이선스","PRO has been deactivated.":"PRO가 비활성화되었습니다.","PRO is active":"PRO가 활성화됨","PRO is active. You do not need to enter the license key again.":"PRO가 활성화되어 있습니다. 라이선스 키를 다시 입력할 필요가 없습니다.","PRO is now active. Sent and received files are unlimited.":"PRO가 활성화되었습니다. 송수신 파일 수는 무제한입니다.","PRO license active":"PRO 라이선스 활성","PRO purchase page coming soon":"PRO 구매 페이지 준비 중","Pair from Connection & Settings in the menu bar.":"메뉴 막대의 ‘연결 및 설정’에서 페어링하세요.","Preparing the receive shortcut…":"수신 단축어 준비 중…","QR code for the iPhone Data Sharing icon URL":"iPhone Data Sharing 아이콘 URL QR 코드","QR code for the setup page URL":"설정 페이지 URL QR 코드","Receive on iPhone":"iPhone에서 수신","Run “iPhone Data Sharing Receive” on your iPhone to save them.":"iPhone에서 ‘iPhone Data Sharing 수신’을 실행하면 저장됩니다.","Safe transfer on the same LAN:":"같은 LAN에서 안전하게 전송:","Send files":"파일 보내기","Send files to your Mac on this LAN.":"이 LAN의 Mac으로 파일을 보냅니다.","Send from Mac to iPhone":"Mac에서 iPhone으로 보내기","Send from iPhone to Mac":"iPhone에서 Mac으로 보내기","Send multiple images, PDFs, documents, and other files at once.":"이미지, PDF, 문서 등 여러 파일을 한 번에 보낼 수 있습니다.","Send to Mac":"Mac으로 보내기","Set up shortcuts":"단축어 설정","Set up the shortcuts used on this iPhone. After the initial setup, you can send and receive without scanning the QR code again.":"이 iPhone에서 사용할 단축어를 설정합니다. 최초 설정 후에는 QR 코드를 다시 스캔하지 않고 송수신할 수 있습니다.","Setup page URL":"설정 페이지 URL","Start Pairing":"페어링 시작","The pairing QR code has expired. Generate a new QR code on your Mac.":"페어링 QR 코드가 만료되었습니다. Mac에서 새 QR 코드를 생성하세요.","The shortcut is generated with Share Sheet enabled and accepts images, media, and files.":"공유 시트가 활성화된 상태로 생성되며 이미지, 미디어, 파일을 받습니다.","There are no pending files right now.":"현재 대기 중인 파일이 없습니다.","There is no limit on sent or received files.":"송수신 파일 수 제한이 없습니다.","This local URL opens iPhone Data Sharing setup from an iPhone on the same LAN. Open it in Safari to get the “Send to Mac” and “iPhone Data Sharing Receive” shortcuts.":"이 로컬 URL은 같은 LAN의 iPhone에서 iPhone Data Sharing 설정을 엽니다. Safari에서 열어 ‘Mac으로 보내기’와 ‘iPhone Data Sharing 수신’ 단축어를 받을 수 있습니다.","This page lets you review and delete pending files. For normal receiving, run the “iPhone Data Sharing Receive” shortcut on your iPhone.":"이 페이지에서 대기 중인 파일을 확인하고 삭제할 수 있습니다. 일반 수신은 iPhone에서 ‘iPhone Data Sharing 수신’ 단축어를 실행하세요.","This shortcut is also generated with Share Sheet enabled for images, media, and files.":"이 단축어도 공유 시트가 활성화되며 이미지, 미디어, 파일을 지원합니다.","Transfer Setup":"전송 설정","Transfer Setup Information":"전송 설정 정보","Upgrade to PRO":"PRO로 업그레이드","Use this shortcut from the iPhone share sheet to send photos, videos, and documents directly to your Mac.":"iPhone 공유 시트에서 이 단축어를 사용해 사진, 동영상, 문서를 Mac으로 직접 보냅니다.","View pending files":"대기 파일 보기","When adding “iPhone Data Sharing Receive” to the Home Screen, you can use the iPhone Data Sharing image. Open the link below on your iPhone, then touch and hold the image to save it.":"‘iPhone Data Sharing 수신’을 홈 화면에 추가할 때 iPhone Data Sharing 이미지를 사용할 수 있습니다. iPhone에서 아래 링크를 열고 이미지를 길게 눌러 저장하세요.","You can also click to choose files.":"클릭해서 파일을 선택할 수도 있습니다.","You can change it later by editing “iPhone Data Sharing Receive” in Shortcuts and changing the destination of the Save File action.":"나중에 단축어 앱에서 ‘iPhone Data Sharing 수신’을 편집하고 ‘파일 저장’ 동작의 저장 위치를 변경할 수 있습니다.","You can change this later by editing “iPhone Data Sharing Receive” in the Shortcuts app and changing the destination of the Save File action.":"나중에 단축어 앱에서 ‘iPhone Data Sharing 수신’을 편집하고 ‘파일 저장’ 동작의 저장 위치를 변경할 수 있습니다.","Your authorization needs to be refreshed.":"인증을 갱신해야 합니다.","install it from the App Store":"App Store에서 설치하세요"," Files are transferred directly within your local network.":" 파일은 로컬 네트워크에서 직접 전송됩니다."," After the first pairing, normal transfers do not require another QR scan.":" 최초 페어링 후 일반 송수신에는 QR 재스캔이 필요하지 않습니다."," File contents are not uploaded to an external cloud service.":" 파일 내용은 외부 클라우드 서비스에 업로드되지 않습니다.",".":".","件を送信中…":"개 파일 전송 중…","Connect your iPhone first.":"먼저 iPhone을 연결하세요.","You are currently using PRO":"현재 PRO 사용 중","Sent and received files are unlimited.":"송수신 파일 수는 무제한입니다.","You are currently using the Free plan":"현재 무료 버전 사용 중","Today: ":"오늘 "," files used":"개 파일 사용"," file(s) sent to iPhone.":"개 파일을 iPhone으로 보냈습니다.","Run “iPhone Data Sharing Receive” on your iPhone.":"iPhone에서 ‘iPhone Data Sharing 수신’을 실행하세요.","• Default save location: iCloud Drive > Shortcuts > iPhone Data Sharing":"• 기본 저장 위치: iCloud Drive > Shortcuts > iPhone Data Sharing","• You can change the save location inside the “iPhone Data Sharing Receive” shortcut.":"• ‘iPhone Data Sharing 수신’ 단축어에서 저장 위치를 변경할 수 있습니다.","Delete":"삭제","Could not delete the file.":"파일을 삭제할 수 없습니다.","Sending…":"전송 중…","View PRO":"PRO 보기","Could not send the files":"파일을 전송할 수 없습니다"," file(s) saved to Mac":"개 파일을 Mac에 저장했습니다","Could not connect. Make sure both devices are on the same Wi‑Fi / LAN.":"연결할 수 없습니다. 같은 Wi‑Fi/LAN인지 확인하세요."},"es":{"Activate":"Activar","Activate license key":"Activar clave de licencia","Activate your license key from the PRO License screen on your Mac.":"Activa la clave de licencia desde la pantalla Licencia PRO en tu Mac.","Activated":"Activada","Add files":"Añadir archivos","Add to Home Screen":"Añadir a pantalla de inicio","After saving the .shortcut file, open it from Files and choose Add Shortcut.":"Después de guardar el archivo .shortcut, ábrelo desde Archivos y elige Añadir atajo.","Allow file transfers with this Mac. Files are transferred securely over the same Wi‑Fi / LAN.":"Permite transferencias con este Mac. Los archivos se transfieren de forma segura por la misma Wi‑Fi/LAN.","Back to transfer":"Volver a transferir","Buy PRO":"Comprar PRO","Checking":"Comprobando","Checking usage…":"Comprobando uso…","Checking your plan…":"Comprobando tu plan…","Checking…":"Comprobando…","Choose files":"Elegir archivos","Choose photos, files, PDFs, and other items from the iPhone share sheet and send them directly to your Mac on the same LAN. After setup, simply choose “Send to Mac” from the Share menu.":"Elige fotos, archivos, PDF y otros elementos desde la hoja de compartir del iPhone y envíalos directamente al Mac en la misma LAN. Después de configurar, solo elige «Enviar al Mac».","Connect to this Mac":"Conectar a este Mac","Connect your iPhone":"Conectar iPhone","Connected":"Conectado","Connected to this Mac. Set up the shortcuts to continue.":"Conectado a este Mac. Configura los atajos para continuar.","Could not deactivate the license":"No se pudo desactivar la licencia","Could not verify the license":"No se pudo verificar la licencia","Deactivate":"Desactivar","Deactivating…":"Desactivando…","Default save location:":"Ubicación predeterminada:","Downloads all pending files from your Mac and saves them to the Files app. It does not use the Photos app.":"Descarga todos los archivos pendientes del Mac y los guarda en Archivos. No usa Fotos.","Downloads all pending files sent from your Mac and saves them to the Files app.":"Descarga todos los archivos pendientes enviados desde el Mac y los guarda en Archivos.","Drag and drop files to send them to your paired iPhone.":"Arrastra y suelta archivos para enviarlos al iPhone enlazado.","Drop files here":"Suelta los archivos aquí","Drop files on this page to put them in the receive queue.":"Suelta archivos en esta página para añadirlos a la cola de recepción.","Enter the license key issued after purchase.":"Introduce la clave de licencia emitida tras la compra.","Expired":"Caducado","iPhone Data Sharing Inbox":"Bandeja de iPhone Data Sharing","iPhone Data Sharing Receive":"Recibir con iPhone Data Sharing","Files stay local:":"Los archivos permanecen locales:","First-run permissions":"Permisos iniciales","From iPhone Data Sharing in the Mac menu bar, choose “Connect iPhone” again to generate a new one.":"En iPhone Data Sharing de la barra de menús del Mac, elige de nuevo «Conectar iPhone» para generar otro.","Generating the shortcut may take a moment. Preparing…":"Generar el atajo puede tardar un momento. Preparando…","Get “iPhone Data Sharing Receive”":"Obtener «Recibir con iPhone Data Sharing»","Get “Send to Mac”":"Obtener «Enviar al Mac»","Home Screen icon":"Icono de pantalla de inicio","How it works":"Cómo funciona","How to add":"Cómo añadir","If network or file-saving permission prompts appear, choose the option that allows continued use.":"Si aparecen permisos de red o guardado, elige la opción que permita seguir usándolo.","If you do not have the Shortcuts app,":"Si no tienes la app Atajos,","In the iPhone Shortcuts app, open “iPhone Data Sharing Receive” → Share → Add to Home Screen. If you want to use an icon, you can use the iPhone Data Sharing image. You can also open the URL below directly on your iPhone.":"En Atajos del iPhone, abre «Recibir con iPhone Data Sharing» → Compartir → Añadir a pantalla de inicio. Si quieres usar un icono, puedes usar la imagen de iPhone Data Sharing. También puedes abrir directamente la URL inferior en el iPhone.","License":"Licencia","License key":"Clave de licencia","Manage inbox":"Gestionar bandeja","New files will appear automatically.":"Los archivos nuevos aparecerán automáticamente.","No repeated QR scanning:":"Sin volver a escanear QR:","Notes":"Notas","On iPhone, touch and hold the image to save it, then choose it as the Home Screen icon.":"En el iPhone, mantén pulsada la imagen para guardarla y úsala como icono de inicio.","On your Mac, open iPhone Data Sharing → Connection & Settings → Transfer Setup, then reinstall the shortcuts if needed.":"En el Mac, abre iPhone Data Sharing → Conexión y ajustes → Configuración de transferencia y reinstala los atajos si hace falta.","On your paired iPhone, open the setup page below and add the shortcuts.":"En el iPhone enlazado, abre la página de configuración inferior y añade los atajos.","Open the iPhone Data Sharing icon on iPhone":"Abrir el icono de iPhone Data Sharing en iPhone","PRO License":"Licencia PRO","PRO has been deactivated.":"PRO se ha desactivado.","PRO is active":"PRO está activo","PRO is active. You do not need to enter the license key again.":"PRO está activo. No necesitas volver a introducir la clave.","PRO is now active. Sent and received files are unlimited.":"PRO está activo. Los archivos enviados y recibidos son ilimitados.","PRO license active":"Licencia PRO activa","PRO purchase page coming soon":"Página de compra PRO próximamente","Pair from Connection & Settings in the menu bar.":"Enlaza desde Conexión y ajustes en la barra de menús.","Preparing the receive shortcut…":"Preparando el atajo de recepción…","QR code for the iPhone Data Sharing icon URL":"QR de la URL del icono de iPhone Data Sharing","QR code for the setup page URL":"QR de la URL de configuración","Receive on iPhone":"Recibir en iPhone","Run “iPhone Data Sharing Receive” on your iPhone to save them.":"Ejecuta «Recibir con iPhone Data Sharing» en el iPhone para guardarlos.","Safe transfer on the same LAN:":"Transferencia segura en la misma LAN:","Send files":"Enviar archivos","Send files to your Mac on this LAN.":"Envía archivos al Mac en esta LAN.","Send from Mac to iPhone":"Enviar del Mac al iPhone","Send from iPhone to Mac":"Enviar del iPhone al Mac","Send multiple images, PDFs, documents, and other files at once.":"Envía varias imágenes, PDF, documentos y otros archivos a la vez.","Send to Mac":"Enviar al Mac","Set up shortcuts":"Configurar atajos","Set up the shortcuts used on this iPhone. After the initial setup, you can send and receive without scanning the QR code again.":"Configura los atajos de este iPhone. Tras la configuración inicial podrás enviar y recibir sin volver a escanear el QR.","Setup page URL":"URL de configuración","Start Pairing":"Iniciar enlace","The pairing QR code has expired. Generate a new QR code on your Mac.":"El QR de enlace ha caducado. Genera uno nuevo en el Mac.","The shortcut is generated with Share Sheet enabled and accepts images, media, and files.":"El atajo se genera con la hoja de compartir activada y acepta imágenes, contenido multimedia y archivos.","There are no pending files right now.":"No hay archivos pendientes ahora.","There is no limit on sent or received files.":"No hay límite de archivos enviados o recibidos.","This local URL opens iPhone Data Sharing setup from an iPhone on the same LAN. Open it in Safari to get the “Send to Mac” and “iPhone Data Sharing Receive” shortcuts.":"Esta URL local abre la configuración de iPhone Data Sharing desde un iPhone en la misma LAN. Ábrela en Safari para obtener los atajos «Enviar al Mac» y «Recibir con iPhone Data Sharing».","This page lets you review and delete pending files. For normal receiving, run the “iPhone Data Sharing Receive” shortcut on your iPhone.":"Esta página permite revisar y eliminar archivos pendientes. Para recibir normalmente, ejecuta «Recibir con iPhone Data Sharing» en el iPhone.","This shortcut is also generated with Share Sheet enabled for images, media, and files.":"Este atajo también se genera con la hoja de compartir activada para imágenes, contenido multimedia y archivos.","Transfer Setup":"Configuración de transferencia","Transfer Setup Information":"Información de configuración","Upgrade to PRO":"Actualizar a PRO","Use this shortcut from the iPhone share sheet to send photos, videos, and documents directly to your Mac.":"Usa este atajo desde la hoja de compartir del iPhone para enviar fotos, vídeos y documentos directamente al Mac.","View pending files":"Ver archivos pendientes","When adding “iPhone Data Sharing Receive” to the Home Screen, you can use the iPhone Data Sharing image. Open the link below on your iPhone, then touch and hold the image to save it.":"Al añadir «Recibir con iPhone Data Sharing» a la pantalla de inicio, puedes usar la imagen de iPhone Data Sharing. Abre el enlace en el iPhone y mantén pulsada la imagen para guardarla.","You can also click to choose files.":"También puedes hacer clic para elegir archivos.","You can change it later by editing “iPhone Data Sharing Receive” in Shortcuts and changing the destination of the Save File action.":"Puedes cambiarlo después editando «Recibir con iPhone Data Sharing» en Atajos y cambiando el destino de Guardar archivo.","You can change this later by editing “iPhone Data Sharing Receive” in the Shortcuts app and changing the destination of the Save File action.":"Puedes cambiarlo después editando «Recibir con iPhone Data Sharing» en Atajos y cambiando el destino de Guardar archivo.","Your authorization needs to be refreshed.":"Debes renovar la autorización.","install it from the App Store":"instálala desde App Store"," Files are transferred directly within your local network.":" Los archivos se transfieren directamente dentro de tu red local."," After the first pairing, normal transfers do not require another QR scan.":" Tras el primer enlace, las transferencias normales no requieren otro escaneo QR."," File contents are not uploaded to an external cloud service.":" El contenido de los archivos no se sube a servicios de nube externos.",".":".","件を送信中…":" archivo(s) enviándose…","Connect your iPhone first.":"Conecta primero el iPhone.","You are currently using PRO":"Actualmente usas PRO","Sent and received files are unlimited.":"Los archivos enviados y recibidos son ilimitados.","You are currently using the Free plan":"Actualmente usas la versión gratuita","Today: ":"Hoy: "," files used":" archivos usados"," file(s) sent to iPhone.":" archivo(s) enviados al iPhone.","Run “iPhone Data Sharing Receive” on your iPhone.":"Ejecuta «Recibir con iPhone Data Sharing» en el iPhone.","• Default save location: iCloud Drive > Shortcuts > iPhone Data Sharing":"• Ubicación predeterminada: iCloud Drive > Shortcuts > iPhone Data Sharing","• You can change the save location inside the “iPhone Data Sharing Receive” shortcut.":"• Puedes cambiar la ubicación dentro del atajo «Recibir con iPhone Data Sharing».","Delete":"Eliminar","Could not delete the file.":"No se pudo eliminar el archivo.","Sending…":"Enviando…","View PRO":"Ver PRO","Could not send the files":"No se pudieron enviar los archivos"," file(s) saved to Mac":" archivo(s) guardados en el Mac","Could not connect. Make sure both devices are on the same Wi‑Fi / LAN.":"No se pudo conectar. Comprueba que ambos dispositivos estén en la misma Wi‑Fi/LAN."},"fr":{"Activate":"Activer","Activate license key":"Activer la clé de licence","Activate your license key from the PRO License screen on your Mac.":"Activez votre clé depuis l’écran Licence PRO sur votre Mac.","Activated":"Activée","Add files":"Ajouter des fichiers","Add to Home Screen":"Ajouter à l’écran d’accueil","After saving the .shortcut file, open it from Files and choose Add Shortcut.":"Après avoir enregistré le fichier .shortcut, ouvrez-le dans Fichiers et choisissez Ajouter un raccourci.","Allow file transfers with this Mac. Files are transferred securely over the same Wi‑Fi / LAN.":"Autorisez les transferts avec ce Mac. Les fichiers sont transférés en toute sécurité sur le même Wi‑Fi/LAN.","Back to transfer":"Retour au transfert","Buy PRO":"Acheter PRO","Checking":"Vérification","Checking usage…":"Vérification de l’utilisation…","Checking your plan…":"Vérification de votre offre…","Checking…":"Vérification…","Choose files":"Choisir des fichiers","Choose photos, files, PDFs, and other items from the iPhone share sheet and send them directly to your Mac on the same LAN. After setup, simply choose “Send to Mac” from the Share menu.":"Choisissez des photos, fichiers, PDF et autres éléments depuis la feuille de partage de l’iPhone et envoyez-les directement au Mac sur le même LAN. Après configuration, choisissez simplement « Envoyer au Mac ».","Connect to this Mac":"Se connecter à ce Mac","Connect your iPhone":"Connecter l’iPhone","Connected":"Connecté","Connected to this Mac. Set up the shortcuts to continue.":"Connecté à ce Mac. Configurez les raccourcis pour continuer.","Could not deactivate the license":"Impossible de désactiver la licence","Could not verify the license":"Impossible de vérifier la licence","Deactivate":"Désactiver","Deactivating…":"Désactivation…","Default save location:":"Emplacement par défaut :","Downloads all pending files from your Mac and saves them to the Files app. It does not use the Photos app.":"Télécharge tous les fichiers en attente depuis le Mac et les enregistre dans Fichiers. Photos n’est pas utilisé.","Downloads all pending files sent from your Mac and saves them to the Files app.":"Télécharge tous les fichiers en attente envoyés depuis le Mac et les enregistre dans Fichiers.","Drag and drop files to send them to your paired iPhone.":"Glissez-déposez des fichiers pour les envoyer à l’iPhone associé.","Drop files here":"Déposez les fichiers ici","Drop files on this page to put them in the receive queue.":"Déposez des fichiers sur cette page pour les ajouter à la file de réception.","Enter the license key issued after purchase.":"Saisissez la clé de licence fournie après l’achat.","Expired":"Expiré","iPhone Data Sharing Inbox":"Boîte de réception iPhone Data Sharing","iPhone Data Sharing Receive":"Réception iPhone Data Sharing","Files stay local:":"Les fichiers restent en local :","First-run permissions":"Autorisations initiales","From iPhone Data Sharing in the Mac menu bar, choose “Connect iPhone” again to generate a new one.":"Dans iPhone Data Sharing de la barre des menus du Mac, choisissez à nouveau « Connecter l’iPhone » pour en générer un nouveau.","Generating the shortcut may take a moment. Preparing…":"La génération du raccourci peut prendre un moment. Préparation…","Get “iPhone Data Sharing Receive”":"Obtenir « Réception iPhone Data Sharing »","Get “Send to Mac”":"Obtenir « Envoyer au Mac »","Home Screen icon":"Icône de l’écran d’accueil","How it works":"Fonctionnement","How to add":"Ajout","If network or file-saving permission prompts appear, choose the option that allows continued use.":"Si des autorisations réseau ou d’enregistrement apparaissent, choisissez l’option permettant l’utilisation continue.","If you do not have the Shortcuts app,":"Si vous n’avez pas l’app Raccourcis,","In the iPhone Shortcuts app, open “iPhone Data Sharing Receive” → Share → Add to Home Screen. If you want to use an icon, you can use the iPhone Data Sharing image. You can also open the URL below directly on your iPhone.":"Dans Raccourcis sur iPhone, ouvrez « Réception iPhone Data Sharing » → Partager → Ajouter à l’écran d’accueil. Vous pouvez utiliser l’image iPhone Data Sharing comme icône. L’URL ci-dessous peut aussi être ouverte directement sur l’iPhone.","License":"Licence","License key":"Clé de licence","Manage inbox":"Gérer la boîte","New files will appear automatically.":"Les nouveaux fichiers apparaîtront automatiquement.","No repeated QR scanning:":"Pas de nouveau scan QR :","Notes":"Remarques","On iPhone, touch and hold the image to save it, then choose it as the Home Screen icon.":"Sur iPhone, maintenez l’image appuyée pour l’enregistrer puis choisissez-la comme icône d’accueil.","On your Mac, open iPhone Data Sharing → Connection & Settings → Transfer Setup, then reinstall the shortcuts if needed.":"Sur votre Mac, ouvrez iPhone Data Sharing → Connexion et réglages → Configuration du transfert, puis réinstallez les raccourcis si nécessaire.","On your paired iPhone, open the setup page below and add the shortcuts.":"Sur l’iPhone associé, ouvrez la page de configuration ci-dessous et ajoutez les raccourcis.","Open the iPhone Data Sharing icon on iPhone":"Ouvrir l’icône iPhone Data Sharing sur iPhone","PRO License":"Licence PRO","PRO has been deactivated.":"PRO a été désactivé.","PRO is active":"PRO est actif","PRO is active. You do not need to enter the license key again.":"PRO est actif. Vous n’avez pas besoin de saisir à nouveau la clé.","PRO is now active. Sent and received files are unlimited.":"PRO est maintenant actif. Les fichiers envoyés et reçus sont illimités.","PRO license active":"Licence PRO active","PRO purchase page coming soon":"Page d’achat PRO bientôt disponible","Pair from Connection & Settings in the menu bar.":"Associez l’appareil depuis Connexion et réglages dans la barre des menus.","Preparing the receive shortcut…":"Préparation du raccourci de réception…","QR code for the iPhone Data Sharing icon URL":"QR de l’URL de l’icône iPhone Data Sharing","QR code for the setup page URL":"QR de l’URL de configuration","Receive on iPhone":"Recevoir sur l’iPhone","Run “iPhone Data Sharing Receive” on your iPhone to save them.":"Exécutez « Réception iPhone Data Sharing » sur l’iPhone pour les enregistrer.","Safe transfer on the same LAN:":"Transfert sûr sur le même LAN :","Send files":"Envoyer des fichiers","Send files to your Mac on this LAN.":"Envoyez des fichiers au Mac sur ce LAN.","Send from Mac to iPhone":"Envoyer du Mac vers l’iPhone","Send from iPhone to Mac":"Envoyer de l’iPhone vers le Mac","Send multiple images, PDFs, documents, and other files at once.":"Envoyez plusieurs images, PDF, documents et autres fichiers en une fois.","Send to Mac":"Envoyer au Mac","Set up shortcuts":"Configurer les raccourcis","Set up the shortcuts used on this iPhone. After the initial setup, you can send and receive without scanning the QR code again.":"Configurez les raccourcis utilisés sur cet iPhone. Après la configuration initiale, vous pourrez envoyer et recevoir sans rescanner le QR.","Setup page URL":"URL de configuration","Start Pairing":"Démarrer l’association","The pairing QR code has expired. Generate a new QR code on your Mac.":"Le QR d’association a expiré. Générez-en un nouveau sur le Mac.","The shortcut is generated with Share Sheet enabled and accepts images, media, and files.":"Le raccourci est généré avec la feuille de partage activée et accepte images, médias et fichiers.","There are no pending files right now.":"Aucun fichier en attente actuellement.","There is no limit on sent or received files.":"Aucune limite de fichiers envoyés ou reçus.","This local URL opens iPhone Data Sharing setup from an iPhone on the same LAN. Open it in Safari to get the “Send to Mac” and “iPhone Data Sharing Receive” shortcuts.":"Cette URL locale ouvre la configuration iPhone Data Sharing depuis un iPhone sur le même LAN. Ouvrez-la dans Safari pour obtenir les raccourcis « Envoyer au Mac » et « Réception iPhone Data Sharing ».","This page lets you review and delete pending files. For normal receiving, run the “iPhone Data Sharing Receive” shortcut on your iPhone.":"Cette page permet de consulter et supprimer les fichiers en attente. Pour la réception normale, exécutez « Réception iPhone Data Sharing » sur l’iPhone.","This shortcut is also generated with Share Sheet enabled for images, media, and files.":"Ce raccourci est également généré avec la feuille de partage activée pour images, médias et fichiers.","Transfer Setup":"Configuration du transfert","Transfer Setup Information":"Informations de configuration","Upgrade to PRO":"Passer à PRO","Use this shortcut from the iPhone share sheet to send photos, videos, and documents directly to your Mac.":"Utilisez ce raccourci depuis la feuille de partage de l’iPhone pour envoyer photos, vidéos et documents directement au Mac.","View pending files":"Voir les fichiers en attente","When adding “iPhone Data Sharing Receive” to the Home Screen, you can use the iPhone Data Sharing image. Open the link below on your iPhone, then touch and hold the image to save it.":"Lorsque vous ajoutez « Réception iPhone Data Sharing » à l’écran d’accueil, vous pouvez utiliser l’image iPhone Data Sharing. Ouvrez le lien sur l’iPhone puis maintenez l’image appuyée pour l’enregistrer.","You can also click to choose files.":"Vous pouvez aussi cliquer pour choisir des fichiers.","You can change it later by editing “iPhone Data Sharing Receive” in Shortcuts and changing the destination of the Save File action.":"Vous pourrez le modifier plus tard en éditant « Réception iPhone Data Sharing » dans Raccourcis et en changeant la destination de l’action Enregistrer le fichier.","You can change this later by editing “iPhone Data Sharing Receive” in the Shortcuts app and changing the destination of the Save File action.":"Vous pourrez le modifier plus tard en éditant « Réception iPhone Data Sharing » dans Raccourcis et en changeant la destination de l’action Enregistrer le fichier.","Your authorization needs to be refreshed.":"Votre autorisation doit être renouvelée.","install it from the App Store":"installez-la depuis l’App Store"," Files are transferred directly within your local network.":" Les fichiers sont transférés directement sur votre réseau local."," After the first pairing, normal transfers do not require another QR scan.":" Après la première association, les transferts normaux ne nécessitent plus de scan QR."," File contents are not uploaded to an external cloud service.":" Le contenu des fichiers n’est pas envoyé vers un service cloud externe.",".":".","件を送信中…":" fichier(s) en cours d’envoi…","Connect your iPhone first.":"Connectez d’abord votre iPhone.","You are currently using PRO":"Vous utilisez actuellement PRO","Sent and received files are unlimited.":"Les fichiers envoyés et reçus sont illimités.","You are currently using the Free plan":"Vous utilisez actuellement la version gratuite","Today: ":"Aujourd’hui : "," files used":" fichiers utilisés"," file(s) sent to iPhone.":" fichier(s) envoyés vers l’iPhone.","Run “iPhone Data Sharing Receive” on your iPhone.":"Exécutez « Réception iPhone Data Sharing » sur votre iPhone.","• Default save location: iCloud Drive > Shortcuts > iPhone Data Sharing":"• Emplacement par défaut : iCloud Drive > Shortcuts > iPhone Data Sharing","• You can change the save location inside the “iPhone Data Sharing Receive” shortcut.":"• Vous pouvez changer l’emplacement dans le raccourci « Réception iPhone Data Sharing ».","Delete":"Supprimer","Could not delete the file.":"Impossible de supprimer le fichier.","Sending…":"Envoi…","View PRO":"Voir PRO","Could not send the files":"Impossible d’envoyer les fichiers"," file(s) saved to Mac":" fichier(s) enregistrés sur le Mac","Could not connect. Make sure both devices are on the same Wi‑Fi / LAN.":"Connexion impossible. Vérifiez que les appareils sont sur le même Wi‑Fi/LAN."},"de":{"Activate":"Aktivieren","Activate license key":"Lizenzschlüssel aktivieren","Activate your license key from the PRO License screen on your Mac.":"Aktiviere deinen Lizenzschlüssel im PRO-Lizenz-Bildschirm auf dem Mac.","Activated":"Aktiviert","Add files":"Dateien hinzufügen","Add to Home Screen":"Zum Home-Bildschirm","After saving the .shortcut file, open it from Files and choose Add Shortcut.":"Speichere die .shortcut-Datei, öffne sie in Dateien und wähle „Kurzbefehl hinzufügen“.","Allow file transfers with this Mac. Files are transferred securely over the same Wi‑Fi / LAN.":"Erlaube Dateiübertragungen mit diesem Mac. Dateien werden sicher über dasselbe WLAN/LAN übertragen.","Back to transfer":"Zurück zur Übertragung","Buy PRO":"PRO kaufen","Checking":"Prüfen","Checking usage…":"Nutzung wird geprüft…","Checking your plan…":"Tarif wird geprüft…","Checking…":"Prüfen…","Choose files":"Dateien auswählen","Choose photos, files, PDFs, and other items from the iPhone share sheet and send them directly to your Mac on the same LAN. After setup, simply choose “Send to Mac” from the Share menu.":"Wähle Fotos, Dateien, PDFs und andere Elemente im iPhone-Teilen-Menü und sende sie direkt an den Mac im selben LAN. Nach der Einrichtung genügt „An Mac senden“.","Connect to this Mac":"Mit diesem Mac verbinden","Connect your iPhone":"iPhone verbinden","Connected":"Verbunden","Connected to this Mac. Set up the shortcuts to continue.":"Mit diesem Mac verbunden. Richte die Kurzbefehle ein, um fortzufahren.","Could not deactivate the license":"Lizenz konnte nicht deaktiviert werden","Could not verify the license":"Lizenz konnte nicht geprüft werden","Deactivate":"Deaktivieren","Deactivating…":"Wird deaktiviert…","Default save location:":"Standard-Speicherort:","Downloads all pending files from your Mac and saves them to the Files app. It does not use the Photos app.":"Lädt alle ausstehenden Dateien vom Mac und speichert sie in der Dateien-App. Die Fotos-App wird nicht verwendet.","Downloads all pending files sent from your Mac and saves them to the Files app.":"Lädt alle vom Mac gesendeten ausstehenden Dateien und speichert sie in der Dateien-App.","Drag and drop files to send them to your paired iPhone.":"Ziehe Dateien hierher, um sie an das gekoppelte iPhone zu senden.","Drop files here":"Dateien hier ablegen","Drop files on this page to put them in the receive queue.":"Lege Dateien auf dieser Seite ab, um sie in die Empfangswarteschlange zu legen.","Enter the license key issued after purchase.":"Gib den nach dem Kauf erhaltenen Lizenzschlüssel ein.","Expired":"Abgelaufen","iPhone Data Sharing Inbox":"iPhone Data Sharing Eingang","iPhone Data Sharing Receive":"iPhone Data Sharing Empfangen","Files stay local:":"Dateien bleiben lokal:","First-run permissions":"Berechtigungen beim ersten Start","From iPhone Data Sharing in the Mac menu bar, choose “Connect iPhone” again to generate a new one.":"Wähle in iPhone Data Sharing in der Mac-Menüleiste erneut „iPhone verbinden“, um einen neuen Code zu erzeugen.","Generating the shortcut may take a moment. Preparing…":"Das Erzeugen des Kurzbefehls kann einen Moment dauern. Vorbereitung…","Get “iPhone Data Sharing Receive”":"„iPhone Data Sharing Empfangen“ laden","Get “Send to Mac”":"„An Mac senden“ laden","Home Screen icon":"Home-Bildschirm-Symbol","How it works":"So funktioniert es","How to add":"Hinzufügen","If network or file-saving permission prompts appear, choose the option that allows continued use.":"Wenn Netzwerk- oder Speicherberechtigungen erscheinen, wähle die Option für dauerhafte Nutzung.","If you do not have the Shortcuts app,":"Wenn die Kurzbefehle-App fehlt,","In the iPhone Shortcuts app, open “iPhone Data Sharing Receive” → Share → Add to Home Screen. If you want to use an icon, you can use the iPhone Data Sharing image. You can also open the URL below directly on your iPhone.":"Öffne in Kurzbefehle auf dem iPhone „iPhone Data Sharing Empfangen“ → Teilen → Zum Home-Bildschirm. Als Symbol kannst du das iPhone-Data-Sharing-Bild verwenden. Die URL unten lässt sich auch direkt auf dem iPhone öffnen.","License":"Lizenz","License key":"Lizenzschlüssel","Manage inbox":"Eingang verwalten","New files will appear automatically.":"Neue Dateien erscheinen automatisch.","No repeated QR scanning:":"Kein erneutes QR-Scannen:","Notes":"Hinweise","On iPhone, touch and hold the image to save it, then choose it as the Home Screen icon.":"Halte das Bild auf dem iPhone gedrückt, speichere es und wähle es als Home-Bildschirm-Symbol.","On your Mac, open iPhone Data Sharing → Connection & Settings → Transfer Setup, then reinstall the shortcuts if needed.":"Öffne auf dem Mac iPhone Data Sharing → Verbindung & Einstellungen → Übertragung einrichten und installiere die Kurzbefehle bei Bedarf neu.","On your paired iPhone, open the setup page below and add the shortcuts.":"Öffne auf dem gekoppelten iPhone die Einrichtungsseite unten und füge die Kurzbefehle hinzu.","Open the iPhone Data Sharing icon on iPhone":"iPhone-Data-Sharing-Symbol auf dem iPhone öffnen","PRO License":"PRO-Lizenz","PRO has been deactivated.":"PRO wurde deaktiviert.","PRO is active":"PRO ist aktiv","PRO is active. You do not need to enter the license key again.":"PRO ist aktiv. Der Lizenzschlüssel muss nicht erneut eingegeben werden.","PRO is now active. Sent and received files are unlimited.":"PRO ist jetzt aktiv. Gesendete und empfangene Dateien sind unbegrenzt.","PRO license active":"PRO-Lizenz aktiv","PRO purchase page coming soon":"PRO-Kaufseite folgt","Pair from Connection & Settings in the menu bar.":"Kopple über Verbindung & Einstellungen in der Menüleiste.","Preparing the receive shortcut…":"Empfangs-Kurzbefehl wird vorbereitet…","QR code for the iPhone Data Sharing icon URL":"QR-Code für die iPhone-Data-Sharing-Symbol-URL","QR code for the setup page URL":"QR-Code für die Einrichtungs-URL","Receive on iPhone":"Auf iPhone empfangen","Run “iPhone Data Sharing Receive” on your iPhone to save them.":"Führe „iPhone Data Sharing Empfangen“ auf dem iPhone aus, um sie zu speichern.","Safe transfer on the same LAN:":"Sichere Übertragung im selben LAN:","Send files":"Dateien senden","Send files to your Mac on this LAN.":"Sende Dateien an deinen Mac in diesem LAN.","Send from Mac to iPhone":"Vom Mac zum iPhone senden","Send from iPhone to Mac":"Vom iPhone zum Mac senden","Send multiple images, PDFs, documents, and other files at once.":"Sende mehrere Bilder, PDFs, Dokumente und andere Dateien gleichzeitig.","Send to Mac":"An Mac senden","Set up shortcuts":"Kurzbefehle einrichten","Set up the shortcuts used on this iPhone. After the initial setup, you can send and receive without scanning the QR code again.":"Richte die Kurzbefehle für dieses iPhone ein. Danach kannst du senden und empfangen, ohne den QR-Code erneut zu scannen.","Setup page URL":"Einrichtungs-URL","Start Pairing":"Kopplung starten","The pairing QR code has expired. Generate a new QR code on your Mac.":"Der Kopplungs-QR-Code ist abgelaufen. Erzeuge auf dem Mac einen neuen.","The shortcut is generated with Share Sheet enabled and accepts images, media, and files.":"Der Kurzbefehl wird mit aktiviertem Teilen-Menü erzeugt und akzeptiert Bilder, Medien und Dateien.","There are no pending files right now.":"Derzeit sind keine Dateien ausstehend.","There is no limit on sent or received files.":"Es gibt kein Limit für gesendete oder empfangene Dateien.","This local URL opens iPhone Data Sharing setup from an iPhone on the same LAN. Open it in Safari to get the “Send to Mac” and “iPhone Data Sharing Receive” shortcuts.":"Diese lokale URL öffnet die iPhone-Data-Sharing-Einrichtung auf einem iPhone im selben LAN. Öffne sie in Safari, um „An Mac senden“ und „iPhone Data Sharing Empfangen“ zu laden.","This page lets you review and delete pending files. For normal receiving, run the “iPhone Data Sharing Receive” shortcut on your iPhone.":"Auf dieser Seite kannst du ausstehende Dateien prüfen und löschen. Für den normalen Empfang führe „iPhone Data Sharing Empfangen“ auf dem iPhone aus.","This shortcut is also generated with Share Sheet enabled for images, media, and files.":"Auch dieser Kurzbefehl wird mit aktiviertem Teilen-Menü für Bilder, Medien und Dateien erzeugt.","Transfer Setup":"Übertragung einrichten","Transfer Setup Information":"Übertragungseinstellungen","Upgrade to PRO":"Auf PRO upgraden","Use this shortcut from the iPhone share sheet to send photos, videos, and documents directly to your Mac.":"Verwende diesen Kurzbefehl im iPhone-Teilen-Menü, um Fotos, Videos und Dokumente direkt an den Mac zu senden.","View pending files":"Ausstehende Dateien anzeigen","When adding “iPhone Data Sharing Receive” to the Home Screen, you can use the iPhone Data Sharing image. Open the link below on your iPhone, then touch and hold the image to save it.":"Beim Hinzufügen von „iPhone Data Sharing Empfangen“ zum Home-Bildschirm kannst du das iPhone-Data-Sharing-Bild verwenden. Öffne den Link auf dem iPhone und halte das Bild zum Speichern gedrückt.","You can also click to choose files.":"Du kannst auch klicken, um Dateien auszuwählen.","You can change it later by editing “iPhone Data Sharing Receive” in Shortcuts and changing the destination of the Save File action.":"Du kannst dies später ändern, indem du „iPhone Data Sharing Empfangen“ in Kurzbefehle bearbeitest und das Ziel von „Datei sichern“ änderst.","You can change this later by editing “iPhone Data Sharing Receive” in the Shortcuts app and changing the destination of the Save File action.":"Du kannst dies später ändern, indem du „iPhone Data Sharing Empfangen“ in Kurzbefehle bearbeitest und das Ziel von „Datei sichern“ änderst.","Your authorization needs to be refreshed.":"Die Autorisierung muss erneuert werden.","install it from the App Store":"installiere sie aus dem App Store"," Files are transferred directly within your local network.":" Dateien werden direkt innerhalb deines lokalen Netzwerks übertragen."," After the first pairing, normal transfers do not require another QR scan.":" Nach der ersten Kopplung ist für normale Übertragungen kein weiterer QR-Scan nötig."," File contents are not uploaded to an external cloud service.":" Dateiinhalte werden nicht zu einem externen Cloud-Dienst hochgeladen.",".":".","件を送信中…":" Datei(en) werden gesendet…","Connect your iPhone first.":"Verbinde zuerst dein iPhone.","You are currently using PRO":"Du verwendest derzeit PRO","Sent and received files are unlimited.":"Gesendete und empfangene Dateien sind unbegrenzt.","You are currently using the Free plan":"Du verwendest derzeit die kostenlose Version","Today: ":"Heute: "," files used":" Dateien verwendet"," file(s) sent to iPhone.":" Datei(en) an das iPhone gesendet.","Run “iPhone Data Sharing Receive” on your iPhone.":"Führe „iPhone Data Sharing Empfangen“ auf dem iPhone aus.","• Default save location: iCloud Drive > Shortcuts > iPhone Data Sharing":"• Standard-Speicherort: iCloud Drive > Shortcuts > iPhone Data Sharing","• You can change the save location inside the “iPhone Data Sharing Receive” shortcut.":"• Den Speicherort kannst du im Kurzbefehl „iPhone Data Sharing Empfangen“ ändern.","Delete":"Löschen","Could not delete the file.":"Datei konnte nicht gelöscht werden.","Sending…":"Senden…","View PRO":"PRO anzeigen","Could not send the files":"Dateien konnten nicht gesendet werden"," file(s) saved to Mac":" Datei(en) auf dem Mac gespeichert","Could not connect. Make sure both devices are on the same Wi‑Fi / LAN.":"Verbindung fehlgeschlagen. Prüfe, ob beide Geräte im selben WLAN/LAN sind."}};

function uiLang(req: Request): UiLang {
  const supported: UiLang[] = ["ja", "en", "zh", "ko", "es", "fr", "de"];
  const query = typeof req.query.lang === "string" ? req.query.lang.toLowerCase().split("-")[0] : "";
  if (supported.includes(query as UiLang)) return query as UiLang;
  const cookie = req.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)file_drop_lang=(ja|en|zh|ko|es|fr|de)(?:;|$)/i);
  if (match) return match[1].toLowerCase() as UiLang;
  const preferred = (req.get("accept-language") ?? "").split(",").map((part) => part.trim().toLowerCase().split(";")[0]);
  for (const item of preferred) {
    const code = item.split("-")[0] as UiLang;
    if (supported.includes(code)) return code;
  }
  return "en";
}
function tr(lang: UiLang, ja: string, en: string): string {
  let value = lang === "ja" ? ja : lang === "en" ? en : (uiTranslations[lang][en] ?? en);
  if (!isWindowsHost) return value;

  // Reuse the Mac translations while adapting host-specific words for Windows.
  value = value.replaceAll("Mac", "PC");
  const trayTerms: Record<UiLang, [string, string]> = {
    ja: ["メニューバー", "タスクトレイ"],
    en: ["menu bar", "system tray"],
    zh: ["菜单栏", "系统托盘"],
    ko: ["메뉴 막대", "시스템 트레이"],
    es: ["barra de menús", "bandeja del sistema"],
    fr: ["barre des menus", "zone de notification"],
    de: ["Menüleiste", "Infobereich"],
  };
  const [from, to] = trayTerms[lang];
  value = value.replaceAll(from, to);
  return value;
}
function shortcutDisplayName(kind: ShortcutKind, lang: UiLang): string {
  return kind === "send" ? tr(lang, "Macに送る", "Send to Mac") : tr(lang, "iPhone Data Sharing受信", "iPhone Data Sharing Receive");
}
function languageCookie(lang: UiLang): string {
  return `file_drop_lang=${lang}; SameSite=Lax; Path=/; Max-Age=${365 * 24 * 60 * 60}`;
}

function windowsSetupCopy(lang: UiLang) {
  const all: Record<UiLang, { title: string; intro: string; send: string; receive: string; auth: string; note: string }> = {
    ja: {
      title: "Windows版：初回ショートカット設定",
      intro: "WindowsではAppleのショートカット署名をPC上で生成できないため、初回追加時だけ以下の値を入力してください。設定後は再入力不要です。",
      send: "送信アドレス",
      receive: "受信アドレス",
      auth: "Authorization",
      note: "ショートカット追加時に表示される質問へ、そのままコピーして入力してください。",
    },
    en: {
      title: "Windows: first-time shortcut setup",
      intro: "Windows cannot create Apple-signed Shortcuts locally, so enter the values below once when importing the shortcuts. You will not need to enter them again afterward.",
      send: "Send address",
      receive: "Receive address",
      auth: "Authorization",
      note: "Copy these values into the import questions shown by the Shortcuts app.",
    },
    zh: {
      title: "Windows：首次快捷指令设置",
      intro: "Windows 无法在本机生成 Apple 签名的快捷指令，因此导入时只需填写一次以下信息。之后无需再次输入。",
      send: "发送地址",
      receive: "接收地址",
      auth: "Authorization",
      note: "请将以下值复制到“快捷指令”App 导入时显示的问题中。",
    },
    ko: {
      title: "Windows: 최초 단축어 설정",
      intro: "Windows에서는 Apple 서명 단축어를 PC에서 생성할 수 없으므로 가져올 때 아래 값을 한 번만 입력하세요. 이후에는 다시 입력할 필요가 없습니다.",
      send: "전송 주소",
      receive: "수신 주소",
      auth: "Authorization",
      note: "단축어 앱에서 가져오기 질문이 표시되면 아래 값을 그대로 복사해 입력하세요.",
    },
    es: {
      title: "Windows: configuración inicial de atajos",
      intro: "Windows no puede generar localmente atajos firmados por Apple. Introduce estos valores una sola vez al importar los atajos; después no tendrás que volver a hacerlo.",
      send: "Dirección de envío",
      receive: "Dirección de recepción",
      auth: "Authorization",
      note: "Copia estos valores en las preguntas de importación de la app Atajos.",
    },
    fr: {
      title: "Windows : configuration initiale des raccourcis",
      intro: "Windows ne peut pas générer localement des raccourcis signés par Apple. Saisissez ces valeurs une seule fois lors de l’importation ; elles ne seront plus demandées ensuite.",
      send: "Adresse d’envoi",
      receive: "Adresse de réception",
      auth: "Authorization",
      note: "Copiez ces valeurs dans les questions d’importation de l’app Raccourcis.",
    },
    de: {
      title: "Windows: erstmalige Kurzbefehl-Einrichtung",
      intro: "Windows kann Apple-signierte Kurzbefehle nicht lokal erzeugen. Gib diese Werte beim Import einmal ein; danach ist keine erneute Eingabe nötig.",
      send: "Sendeadresse",
      receive: "Empfangsadresse",
      auth: "Authorization",
      note: "Kopiere diese Werte in die Importfragen der Kurzbefehle-App.",
    },
  };
  return all[lang];
}

function phone(req: Request, res: Response, next: NextFunction): void {
  const raw = requestCredential(req);
  if (!raw || !currentSession(req) || !sameOrigin(req)) { res.status(401).json({ error: "ペアリングが必要です" }); return; }
  if (req.query.home === raw) res.setHeader("Set-Cookie", `iphone_share=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionLifetime / 1000)}`);
  next();
}
function phonePage(req: Request, res: Response, next: NextFunction): void {
  if (!requestCredential(req) || !currentSession(req) || !sameOrigin(req)) {
    const lang = uiLang(req);
    res.status(401).send(page(
      tr(lang, "iPhone Data Sharing受信画面", "iPhone Data Sharing Receive"),
      `<h1>${tr(lang, "iPhone Data Sharing受信画面", "iPhone Data Sharing Receive")}</h1><p>${tr(lang, "認証を更新する必要があります。", "Your authorization needs to be refreshed.")}</p><p>${tr(lang, "Macの「接続・設定」→「送受信設定情報」から設定ページを開き、必要に応じてショートカットを取り込み直してください。", "On your Mac, open iPhone Data Sharing → Connection & Settings → Transfer Setup, then reinstall the shortcuts if needed.")}</p>`,
      lang,
    ));
    return;
  }
  phone(req, res, next);
}
function page(title: string, body: string, lang: UiLang = "ja"): string {
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="iPhone Data Sharing"><link rel="apple-touch-icon" href="/app-icon.png"><link rel="icon" type="image/png" href="/app-icon.png"><link rel="shortcut icon" href="/app-icon.png"><title>${escapeHtml(title)}</title><style>
  :root{--bg:#f4f7fb;--bg2:#eef4ff;--card:#ffffff;--line:#d8e1ee;--text:#142033;--muted:#607089;--primary:#167ea0;--primary-dark:#0e6c8a;--secondary:#e9eef5;--shadow:0 18px 48px rgba(19,34,54,.08);--radius:24px;--radius-sm:16px}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.65 -apple-system,BlinkMacSystemFont,"SF Pro Text","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;color:var(--text);background:radial-gradient(circle at top left,#f9fbff 0%,var(--bg2) 24%,var(--bg) 55%,#f6f8fc 100%);padding:28px 18px 44px}
  main{max-width:920px;margin:0 auto}
  .shell{background:rgba(255,255,255,.86);backdrop-filter:saturate(140%) blur(16px);border:1px solid rgba(215,225,239,.8);border-radius:32px;box-shadow:var(--shadow);overflow:hidden}
  .hero{padding:30px 30px 18px;background:linear-gradient(180deg,rgba(22,126,160,.085),rgba(255,255,255,0));border-bottom:1px solid rgba(216,225,238,.72)}
  .hero-head{margin-bottom:10px}
  .hero-title-row{display:flex;gap:14px;align-items:center;min-width:0}
  .hero-title-row h1{margin:0;min-width:0}
  .appmark{width:46px;height:46px;flex:0 0 46px;border-radius:14px;background:linear-gradient(180deg,#1a9dbc,#157f9e);display:grid;place-items:center;box-shadow:0 14px 28px rgba(22,126,160,.18)}
  .appmark img{width:28px;height:28px;display:block}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;padding:7px 11px;border-radius:999px;background:#eef7fa;color:#0f6f8f;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
  h1{font-size:42px;line-height:1.12;letter-spacing:-.03em;margin:10px 0 8px}
  h2{font-size:28px;line-height:1.22;letter-spacing:-.02em;margin:26px 0 10px}
  h3{font-size:19px;line-height:1.35;margin:0 0 8px}
  p{margin:0 0 14px}
  .lede{font-size:18px;color:#233047;max-width:760px}
  .content{padding:26px 30px 32px}
  .stack > * + *{margin-top:16px}
  .grid{display:grid;gap:18px}
  .grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}
  .card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:22px;box-shadow:0 10px 30px rgba(20,32,51,.04)}
  .card.soft{background:linear-gradient(180deg,#fbfdff 0%,#f7fbff 100%)}
  .muted,.hint{color:var(--muted)}
  .mini{font-size:14px}
  .button-row{display:flex;flex-wrap:wrap;gap:12px}
  button,.button{appearance:none;border:none;border-radius:14px;padding:13px 18px;font:600 15px/1.2 inherit;cursor:pointer;transition:.18s transform ease,.18s box-shadow ease,.18s background ease;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px}
  button:hover,.button:hover{transform:translateY(-1px)}
  button:active,.button:active{transform:translateY(0)}
  button,.button.primary{background:linear-gradient(180deg,#1a97b8,#157f9e);color:white;box-shadow:0 12px 26px rgba(21,127,158,.18)}
  button.secondary,.button.secondary{background:var(--secondary);color:var(--text);box-shadow:none}
  button.ghost,.button.ghost{background:transparent;color:var(--primary-dark);border:1px solid var(--line);box-shadow:none}
  button:disabled{opacity:.58;cursor:default;transform:none}
  input,code,pre{font:inherit}
  input[type=file]{max-width:100%}
  .input-display,.box{border:1px solid var(--line);border-radius:18px;padding:16px 18px;background:#fbfcfe}
  .input-display code,.box code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;color:#22324b;word-break:break-all}
  .dropzone{border:2px dashed #a7c9d5;border-radius:24px;padding:54px 24px;text-align:center;background:linear-gradient(180deg,#fbfeff 0%,#f4f9fb 100%);transition:.2s background ease,.2s border-color ease,.2s transform ease;cursor:pointer}
  .dropzone:hover,.dropzone.active{background:linear-gradient(180deg,#f5fcff 0%,#edf8fb 100%);border-color:#4ea7bf;transform:translateY(-1px)}
  .dropzone .icon{font-size:36px;line-height:1;margin-bottom:12px}
  .dropzone strong{font-size:24px;letter-spacing:-.02em;display:block;margin-bottom:8px}
  .status{min-height:24px;white-space:pre-line;color:#24415b}
  .stats{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px}
  .stat{padding:10px 12px;border-radius:14px;background:#f4f8fc;border:1px solid var(--line);font-size:14px;color:#42536a}
  .file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px}
  .file-card{border:1px solid var(--line);border-radius:18px;padding:14px;background:white;box-shadow:0 8px 20px rgba(20,32,51,.04)}
  .thumb{width:100%;aspect-ratio:4/3;object-fit:cover;background:#eef3f8;border-radius:12px}
  .file-icon{display:grid;place-items:center;font-size:40px;color:#6a7d92}
  .file-name{overflow-wrap:anywhere;font-size:14px;min-height:44px;margin:12px 0;color:#253248}
  .list{display:grid;gap:14px}
  .feature{display:flex;gap:14px;align-items:flex-start}
  .feature .badge{flex:0 0 auto;width:38px;height:38px;border-radius:12px;background:#eef7fa;color:#0f6f8f;display:grid;place-items:center;font-weight:800}
  .pro-card{border:1px solid #e4d4a5;background:linear-gradient(180deg,#fffdf6 0%,#fff9e8 100%)}
  .pro-card.compact{padding:14px 18px}
  .pro-badge{display:inline-flex;padding:6px 10px;border-radius:999px;background:#fff0bd;color:#7b5a00;font-size:12px;font-weight:800}
  .plan-bar{display:flex;align-items:center;justify-content:space-between;gap:16px}
  .plan-main{display:flex;align-items:center;gap:12px;min-width:0}
  .plan-copy h3,.plan-copy p{margin:0}
  .plan-copy p{margin-top:4px}
  .plan-actions{display:flex;align-items:center;gap:10px;flex:0 0 auto}
  .plan-link{font-weight:700;white-space:nowrap}
  .license-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:8px}
  .license-head h3{margin:0}
  .license-input{width:min(100%,420px);padding:13px 14px;border:1px solid var(--line);border-radius:12px;background:white}
  .guide-qr-row{display:grid;grid-template-columns:minmax(0,1fr) 96px;gap:18px;align-items:start}
  .guide-qr{width:96px;height:96px;border-radius:10px;background:#fff;border:1px solid var(--line);padding:5px}
  .link-url-gap{height:12px}
  .language-switch{position:absolute;top:24px;right:28px;display:flex;gap:6px;z-index:2}
  .language-switch a{font-size:12px;font-weight:700;text-decoration:none;padding:5px 8px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.8)}
  .language-switch a.active{background:#e8f5f8;color:var(--primary-dark)}
  a{color:var(--primary-dark)}
  .spacer-sm{height:4px}
  img{display:block;max-width:100%}
  @media (max-width:720px),(hover:none) and (pointer:coarse) and (max-width:1024px){.language-switch{display:none}body{padding:16px 12px 32px}.hero{padding:22px 20px 14px}.content{padding:20px}.grid.two{grid-template-columns:1fr}h1{font-size:32px}h2{font-size:24px}.dropzone{padding:42px 18px}}
  </style><main><div class="shell" style="position:relative"><nav class="language-switch" aria-label="Language">
<a href="#" data-ui-lang="ja" class="${lang === "ja" ? "active" : ""}">日本語</a>
<a href="#" data-ui-lang="en" class="${lang === "en" ? "active" : ""}">English</a>
<a href="#" data-ui-lang="zh" class="${lang === "zh" ? "active" : ""}">中文</a>
<a href="#" data-ui-lang="ko" class="${lang === "ko" ? "active" : ""}">한국어</a>
<a href="#" data-ui-lang="es" class="${lang === "es" ? "active" : ""}">Español</a>
<a href="#" data-ui-lang="fr" class="${lang === "fr" ? "active" : ""}">Français</a>
<a href="#" data-ui-lang="de" class="${lang === "de" ? "active" : ""}">Deutsch</a>
</nav><div class="hero"><div class="hero-head"><div class="eyebrow">iPhone Data Sharing</div></div><div class="hero-title-row"><div class="appmark"><img src="/app-icon.png" alt=""></div><h1>${escapeHtml(title)}</h1></div></div><div class="content stack">${body}</div></div></main><script>
document.querySelectorAll('[data-ui-lang]').forEach((link)=>{
  link.addEventListener('click',(event)=>{
    event.preventDefault();
    const next=location.pathname+location.search+location.hash;
    location.href='/language/'+link.dataset.uiLang+'?next='+encodeURIComponent(next);
  });
});
</script></html>`;
}
type ShortcutKind = "send" | "receive";
type ShortcutManifest = {
  revision: string;
  kind: ShortcutKind;
  mode: "--configured-send" | "--configured-receive";
  address: string;
  target: string;
  sha256: string;
  size: number;
  generatedAt: string;
};

function shortcutManifestPath(file: string): string {
  return `${file}.manifest.json`;
}

async function fileSha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function expectedShortcutAddress(kind: ShortcutKind): string {
  return kind === "send"
    ? `${baseUrl}/phone/shortcut`
    : `${baseUrl}/phone/shortcut/inbox`;
}

function expectedShortcutMode(kind: ShortcutKind): "--configured-send" | "--configured-receive" {
  return kind === "send" ? "--configured-send" : "--configured-receive";
}

async function writeShortcutManifest(
  file: string,
  kind: ShortcutKind,
  mode: "--configured-send" | "--configured-receive",
  address: string,
): Promise<void> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`生成された ${kind} ショートカットが空です`);
  const manifest: ShortcutManifest = {
    revision: shortcutRevision,
    kind,
    mode,
    address,
    target: path.basename(file),
    sha256: await fileSha256(file),
    size: stat.size,
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(shortcutManifestPath(file), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

async function assertShortcutForDownload(file: string, expectedKind: ShortcutKind): Promise<ShortcutManifest> {
  let manifest: ShortcutManifest;
  try {
    manifest = JSON.parse(await fs.readFile(shortcutManifestPath(file), "utf8")) as ShortcutManifest;
  } catch {
    throw new Error(`${expectedKind} ショートカットの診断マニフェストがありません。再生成してください。`);
  }

  const expectedAddress = expectedShortcutAddress(expectedKind);
  const expectedMode = expectedShortcutMode(expectedKind);
  const stat = await fs.stat(file);
  const actualHash = await fileSha256(file);

  if (
    manifest.revision !== shortcutRevision ||
    manifest.kind !== expectedKind ||
    manifest.mode !== expectedMode ||
    manifest.address !== expectedAddress ||
    manifest.target !== path.basename(file) ||
    manifest.size !== stat.size ||
    manifest.sha256 !== actualHash
  ) {
    console.error("[shortcut-guard] 配布拒否", {
      expectedKind,
      expectedMode,
      expectedAddress,
      file: path.basename(file),
      manifest,
      actualSize: stat.size,
      actualHash,
    });
    throw new Error(`ショートカット種別の整合性検証に失敗しました (${expectedKind})`);
  }

  if (expectedKind === "send" && /\/phone\/shortcut\/inbox(?:$|[/?#])/.test(manifest.address)) {
    throw new Error("送信用ショートカットに受信用 /inbox アドレスが混入しています");
  }
  if (expectedKind === "receive" && !/\/phone\/shortcut\/inbox$/.test(manifest.address)) {
    throw new Error("受信用ショートカットの /inbox アドレスが不正です");
  }

  return manifest;
}
async function staticShortcutFile(kind: ShortcutKind, lang: UiLang): Promise<string> {
  if (!staticShortcutDirectory) throw new Error("Static shortcut directory is not configured.");
  const candidates = [
    path.join(staticShortcutDirectory, `${kind}-${lang}.shortcut`),
    path.join(staticShortcutDirectory, `${kind}-en.shortcut`),
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 0) return candidate;
    } catch { /* Try the fallback. */ }
  }
  throw new Error(`署名済みショートカットが見つかりません (${kind}/${lang})`);
}

async function shortcutManifestForServing(file: string, expectedKind: ShortcutKind): Promise<ShortcutManifest> {
  if (!staticShortcutDirectory) return assertShortcutForDownload(file, expectedKind);
  const stat = await fs.stat(file);
  return {
    revision: `${shortcutRevision}-static`,
    kind: expectedKind,
    mode: expectedShortcutMode(expectedKind),
    address: expectedShortcutAddress(expectedKind),
    target: path.basename(file),
    sha256: await fileSha256(file),
    size: stat.size,
    generatedAt: "pre-signed-template",
  };
}

async function configuredShortcut(raw: string, kind: ShortcutKind, lang: UiLang = "ja"): Promise<string> {
  if (!baseUrl) {
    throw new Error(isWindowsHost ? "LANアドレスを検出できません。Windows PCをLAN/Wi-Fiへ接続するか PUBLIC_BASE_URL を設定してください。" : "LANアドレスを検出できません。MacをLAN/Wi-Fiへ接続するか PUBLIC_BASE_URL を設定してください。");
  }
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(baseUrl)) {
    throw new Error("iPhoneから到達できないループバックアドレスではショートカットを生成できません。");
  }
  if (!raw || /PAIRING_TOKEN|PC-IP/.test(raw)) {
    throw new Error("有効なペアリングトークンがありません。iPhoneを再ペアリングしてください。");
  }

  if (staticShortcutDirectory) {
    const file = await staticShortcutFile(kind, lang);
    console.log("[shortcut-static-template]", {
      kind,
      lang,
      file: path.basename(file),
      revision: shortcutRevision,
    });
    return file;
  }

  const address = expectedShortcutAddress(kind);
  const mode = expectedShortcutMode(kind);
  const key = `${digest(raw)}:${kind}:${lang}:${shortcutRevision}`;
  const existing = configuredShortcuts.get(key);

  if (existing) {
    try {
      const manifest = await assertShortcutForDownload(existing, kind);
      console.log("[shortcut-cache-hit]", {
        kind,
        mode,
        address,
        file: path.basename(existing),
        sha256: manifest.sha256.slice(0, 12),
        size: manifest.size,
      });
      return existing;
    } catch (error) {
      console.warn("[shortcut-cache-invalid] 再生成します", {
        kind,
        file: path.basename(existing),
        error: error instanceof Error ? error.message : String(error),
      });
      configuredShortcuts.delete(key);
      await fs.unlink(existing).catch(() => undefined);
      await fs.unlink(shortcutManifestPath(existing)).catch(() => undefined);
    }
  }

  const target = path.join(
    generatedDirectory,
    `${digest(`${raw}:${kind}:${lang}:${shortcutRevision}`)}-${kind}.shortcut`,
  );

  // Remove a stale artifact before signing so a failed build can never be served.
  await fs.unlink(target).catch(() => undefined);
  await fs.unlink(shortcutManifestPath(target)).catch(() => undefined);

  console.log("[shortcut-generate-start]", {
    kind,
    mode,
    address,
    file: path.basename(target),
    revision: shortcutRevision,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/python3", [shortcutBuilder, mode, target], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString().slice(0, 4096);
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`署名に失敗しました (${code}): ${errors}`)),
      );
      child.stdin.end(
        JSON.stringify({
          address,
          authorization: `Bearer ${raw}`,
          locale: lang,
        }),
      );
    });

    await writeShortcutManifest(target, kind, mode, address);
    const manifest = await assertShortcutForDownload(target, kind);

    console.log("[shortcut-generate-complete]", {
      kind,
      mode,
      address,
      file: path.basename(target),
      sha256: manifest.sha256.slice(0, 12),
      size: manifest.size,
    });
  } catch (error) {
    await fs.unlink(target).catch(() => undefined);
    await fs.unlink(shortcutManifestPath(target)).catch(() => undefined);
    console.error("[shortcut-generate-failed]", {
      kind,
      mode,
      address,
      file: path.basename(target),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  configuredShortcuts.set(key, target);
  return target;
}

async function moveExclusive(source: string, name: string): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const safe = cleanName(name);
    const parsed = path.parse(safe);
    const dest = path.join(downloads, n ? `${parsed.name} (${n})${parsed.ext}` : safe);
    try {
      await fs.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
      await fs.unlink(source);
      receivedCount++;
      return path.basename(dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("保存先のファイル名を決められません");
}

const disk = multer.diskStorage({ destination: scratch, filename: (_req, _file, cb) => cb(null, token()) });
const upload = multer({ storage: disk, limits: { fileSize: maxFileSize, files: 20 } });
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.get("/language/:lang", (req, res) => {
  const candidate = req.params.lang.toLowerCase().split("-")[0];
  const lang: UiLang = (["ja","en","zh","ko","es","fr","de"] as string[]).includes(candidate) ? candidate as UiLang : "en";
  const requested = typeof req.query.next === "string" ? req.query.next : "/";
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
  res.setHeader("Set-Cookie", languageCookie(lang));
  res.redirect(next);
});
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/app-icon.png", async (_req, res) => {
  for (const candidate of iconCandidates) {
    try { await fs.access(candidate); res.type("image/png").sendFile(candidate); return; } catch { /* Try the packaged location. */ }
  }
  res.status(404).end();
});
app.get("/install/file-drop-icon.png", phone, async (req, res) => {
  for (const candidate of iconCandidates) {
    try {
      await fs.access(candidate);
      res.setHeader("Cache-Control", "private, no-store");
      res.download(candidate, "iPhone Data Sharing.png");
      return;
    } catch { /* Try the packaged location. */ }
  }
  res.status(404).json({ error: tr(uiLang(req), "iPhone Data Sharingアイコンが見つかりません", "iPhone Data Sharing icon not found") });
});
app.get("/admin/download-directory", admin, (_req, res) => res.json({ directory: downloads }));
app.post("/admin/download-directory", admin, async (req, res) => {
  const directory = req.body?.directory;
  if (typeof directory !== "string" || !path.isAbsolute(directory)) { res.status(400).json({ error: "保存先のフォルダを選んでください" }); return; }
  try {
    if (!(await fs.stat(directory)).isDirectory()) { res.status(400).json({ error: "フォルダを選んでください" }); return; }
    await fs.access(directory, fs.constants.W_OK);
    const staging = path.join(dataDirectory, `download-directory-${token()}.tmp`);
    await fs.writeFile(staging, JSON.stringify({ directory }), { mode: 0o600 });
    await fs.rename(staging, downloadPreferenceFile);
    downloads = directory;
    res.json({ directory });
  } catch { res.status(400).json({ error: "選択したフォルダに保存できません" }); }
});
app.get("/install/send-to-pc.shortcut", phone, async (req, res, next) => {
  try {
    const raw = sessionToken(req)!;
    const lang = uiLang(req);
    const file = await configuredShortcut(raw, "send", lang);
    res.setHeader("Cache-Control", "private, no-store");
    res.download(file, `${shortcutDisplayName("send", lang)}.shortcut`);
  } catch (error) { next(error); }
});
app.get("/install/local-save.shortcut", phone, (_req, res) => res.download(path.join(shortcutDirectory, "ファイルを移動.shortcut"), "ファイルを移動.shortcut"));
app.get("/install/one-click.shortcut", phone, async (req, res, next) => {
  console.log("[shortcut-download-request]", {
    route: "/install/one-click.shortcut",
    kind: "send",
    userAgent: req.get("user-agent"),
  });
  try {
    const raw = sessionToken(req)!;
    const lang = uiLang(req);
    const file = await configuredShortcut(raw, "send", lang);
    const manifest = await shortcutManifestForServing(file, "send");
    console.log("[shortcut-download]", {
      route: "/install/one-click.shortcut",
      kind: "send",
      address: manifest.address,
      file: path.basename(file),
      sha256: manifest.sha256.slice(0, 12),
      size: manifest.size,
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-iPhone-Data-Sharing-Shortcut-Kind", "send");
    res.setHeader("X-iPhone-Data-Sharing-Shortcut-Revision", shortcutRevision);
    res.setHeader("X-iPhone-Data-Sharing-Shortcut-SHA256", manifest.sha256);
    res.download(file, `${shortcutDisplayName("send", lang)}.shortcut`);
  } catch (error) { next(error); }
});
app.get("/install/receive.shortcut", phone, async (req, res, next) => {
  console.log("[shortcut-download-request]", {
    route: "/install/receive.shortcut",
    kind: "receive",
    userAgent: req.get("user-agent"),
  });
  try {
    const raw = sessionToken(req)!;
    const lang = uiLang(req);
    const file = await configuredShortcut(raw, "receive", lang);
    const manifest = await shortcutManifestForServing(file, "receive");
    console.log("[shortcut-download]", {
      route: "/install/receive.shortcut",
      kind: "receive",
      address: manifest.address,
      file: path.basename(file),
      sha256: manifest.sha256.slice(0, 12),
      size: manifest.size,
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-iPhone-Data-Sharing-Shortcut-Kind", "receive");
    res.setHeader("X-iPhone-Data-Sharing-Shortcut-Revision", shortcutRevision);
    res.setHeader("X-iPhone-Data-Sharing-Shortcut-SHA256", manifest.sha256);
    res.download(file, `${shortcutDisplayName("receive", lang)}.shortcut`);
  } catch (error) { next(error); }
});

app.get("/admin/license", admin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(licenseSummary());
});
app.post("/admin/license/activate", admin, async (req, res, next) => {
  try {
    const key = typeof req.body?.licenseKey === "string" ? req.body.licenseKey : "";
    const result = await activateLicenseKey(key);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json({ ok: true, ...licenseSummary() });
  } catch (error) { next(error); }
});
app.post("/admin/license/deactivate", admin, async (_req, res, next) => {
  try {
    await deactivateLicense();
    res.json({ ok: true, ...licenseSummary() });
  } catch (error) { next(error); }
});
app.get("/admin/usage", admin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(licenseSummary());
});
app.get("/pro", (req, res) => {
  const lang = uiLang(req);
  const local = isLocal(req);
  const status = licenseSummary();
  const purchase = proPurchaseUrl
    ? `<a class="button primary" href="${escapeHtml(proPurchaseUrl)}" rel="noopener noreferrer">${tr(lang, "PRO版を購入する", "Buy PRO")}</a>`
    : `<span class="button secondary" aria-disabled="true">${tr(lang, "PRO購入ページは準備中", "PRO purchase page coming soon")}</span>`;
  let activation = "";
  if (status.plan === "pro") {
    activation = `<section class="card soft"><div class="license-head"><h3>${tr(lang, "ライセンス", "License")}</h3><a href="#" id="deactivate-license" class="plan-link">${tr(lang, "有効化解除", "Deactivate")}</a></div><p class="muted">${tr(lang, "PRO版は有効です。ライセンスキーの再入力は不要です。", "PRO is active. You do not need to enter the license key again.")}</p><div class="button-row"><input class="license-input" type="password" value="••••••••" disabled aria-label="${tr(lang, "PROライセンス有効", "PRO license active")}"><button disabled>${tr(lang, "有効化済み", "Activated")}</button></div><p id="license-status" class="status"></p></section><script>
document.querySelector('#deactivate-license').onclick=async(event)=>{event.preventDefault();const status=document.querySelector('#license-status');status.textContent='${tr(lang, "解除中…", "Deactivating…")}';try{const r=await fetch('/admin/license/deactivate',{method:'POST'});const j=await r.json();if(!r.ok)throw Error(j.error||'${tr(lang, "ライセンスの有効化を解除できませんでした", "Could not deactivate the license")}');status.textContent='${tr(lang, "PRO版の有効化を解除しました。", "PRO has been deactivated.")}';setTimeout(()=>location.reload(),400)}catch(e){status.textContent=e.message}};
</script>`;
  } else if (local) {
    activation = `<section class="card soft"><h3>${tr(lang, "ライセンスキーを有効化", "Activate license key")}</h3><p class="muted">${tr(lang, "購入後に発行されるライセンスキーを入力します。", "Enter the license key issued after purchase.")}</p><div class="button-row"><input id="license-key" class="license-input" type="password" autocomplete="off" placeholder="${tr(lang, "ライセンスキー", "License key")}"><button id="activate-license">${tr(lang, "有効化する", "Activate")}</button></div><p id="license-status" class="status"></p></section><script>
const licenseButton=document.querySelector('#activate-license');licenseButton.onclick=async()=>{const status=document.querySelector('#license-status');const key=document.querySelector('#license-key').value;status.textContent='${tr(lang, "確認中…", "Checking…")}';try{const r=await fetch('/admin/license/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({licenseKey:key})});const j=await r.json();if(!r.ok)throw Error(j.error||'${tr(lang, "ライセンスを確認できませんでした", "Could not verify the license")}');status.textContent='${tr(lang, "PRO版を有効化しました。送受信ファイル数は無制限です。", "PRO is now active. Sent and received files are unlimited.")}';setTimeout(()=>location.reload(),500)}catch(e){status.textContent=e.message}};
</script>`;
  } else {
    activation = `<section class="card soft"><p class="muted">${tr(lang, "ライセンスキーの有効化はMac側のPROライセンス画面から行ってください。", "Activate your license key from the PRO License screen on your Mac.")}</p></section>`;
  }
  res.send(page(status.plan === "pro" ? tr(lang, "PROライセンス", "PRO License") : tr(lang, "PRO版にアップデート", "Upgrade to PRO"),
    `<p class="lede">${tr(lang, `無料版は1日${freeDailyLimit}ファイル（送受信計）まで、PRO版はローカル転送を無制限で利用できます。`, `The Free plan allows up to ${freeDailyLimit} files per day in total (sent + received). PRO provides unlimited local transfers.`)}</p><section class="card pro-card"><span class="pro-badge">${status.plan === "pro" ? "PRO" : "FREE"}</span><h2>${status.plan === "pro" ? tr(lang, "PRO版が有効です", "PRO is active") : tr(lang, "PRO版にアップデート", "Upgrade to PRO")}</h2><p>${status.plan === "pro" ? tr(lang, "送受信ファイル数の制限はありません。", "There is no limit on sent or received files.") : tr(lang, `本日の無料利用: ${status.usedToday} / ${freeDailyLimit}ファイル`, `Today's Free usage: ${status.usedToday} / ${freeDailyLimit} files`)}</p><div class="button-row">${status.plan === "pro" ? "" : purchase}<a class="button ghost" href="/transfer">${tr(lang, "送信画面へ戻る", "Back to transfer")}</a></div></section>${activation}`, lang));
});

app.get("/transfer", admin, (req, res) => {
  const lang = uiLang(req);
  res.send(page(tr(lang, "PCからiPhoneへ送信", "Send from Mac to iPhone"), `<p class="lede">${tr(lang, "ドラッグ＆ドロップするだけで、ペアリング済みのiPhoneへファイルを送れます。", "Drag and drop files to send them to your paired iPhone.")}</p>
<section class="card pro-card" id="plan-card"><div class="plan-bar"><div class="plan-main"><span class="pro-badge" id="plan-badge">${tr(lang, "確認中", "Checking")}</span><div class="plan-copy"><h3 id="plan-title">${tr(lang, "プランを確認中…", "Checking your plan…")}</h3><p class="muted" id="plan-status">${tr(lang, "利用状況を確認中…", "Checking usage…")}</p></div></div><div class="plan-actions"><a class="button ghost" id="upgrade-link" href="/pro">${tr(lang, "PRO版にアップデートする", "Upgrade to PRO")}</a><a class="plan-link" id="pro-link" href="/pro" hidden>${tr(lang, "PROライセンス", "PRO License")}</a></div></div></section>
<div class="grid two"><section class="card"><h3>${tr(lang, "ファイルを送る", "Send files")}</h3><p class="muted">${tr(lang, "画像、PDF、書類など複数ファイルをまとめて送信できます。", "Send multiple images, PDFs, documents, and other files at once.")}</p><div id="drop" class="dropzone" tabindex="0" role="button" aria-label="${tr(lang, "ファイルを選択", "Choose files")}"><div class="icon">✈</div><strong>${tr(lang, "ここにファイルをドロップ", "Drop files here")}</strong><span class="muted">${tr(lang, "クリックして選択することもできます。", "You can also click to choose files.")}</span></div><input id="file" type="file" multiple hidden><p id="status" class="status"></p></section>
<section class="card"><h3>${tr(lang, "ご利用の流れ", "How it works")}</h3><div class="list"><div class="feature"><div class="badge">1</div><div><strong>${tr(lang, "iPhoneを接続", "Connect your iPhone")}</strong><br><span class="muted">${tr(lang, "メニューバーの「接続・設定」からペアリングします。", "Pair from Connection & Settings in the menu bar.")}</span></div></div><div class="feature"><div class="badge">2</div><div><strong>${tr(lang, "ファイルを投入", "Add files")}</strong><br><span class="muted">${tr(lang, "このページにファイルをドロップすると受信箱に入ります。", "Drop files on this page to put them in the receive queue.")}</span></div></div><div class="feature"><div class="badge">3</div><div><strong>${tr(lang, "iPhoneで受信", "Receive on iPhone")}</strong><br><span class="muted">${tr(lang, "iPhone側で「iPhone Data Sharing受信」を実行すると保存されます。", "Run “iPhone Data Sharing Receive” on your iPhone to save them.")}</span></div></div></div><ul class="muted mini"><li><strong>${tr(lang, "同一LANで安全に転送：", "Safe transfer on the same LAN:")}</strong>${tr(lang, "ファイル本体は同じネットワーク内で直接やり取りします。", " Files are transferred directly within your local network.")}</li><li><strong>${tr(lang, "QRの読み直しは不要：", "No repeated QR scanning:")}</strong>${tr(lang, "初回ペアリング後は、通常の送受信でQRコードを読み直す必要はありません。", " After the first pairing, normal transfers do not require another QR scan.")}</li><li><strong>${tr(lang, "ファイルはローカルで完結：", "Files stay local:")}</strong>${tr(lang, "転送するファイル本体を外部クラウドへアップロードしません。", " File contents are not uploaded to an external cloud service.")}</li></ul></section></div>
<script>
const copy=${JSON.stringify({
  sendingSuffix: tr(lang, "件を送信中…", " file(s) sending…"),
  connect: tr(lang, "先にiPhoneを接続してください", "Connect your iPhone first."),
  upgrade: tr(lang, "PRO版にアップデートする", "Upgrade to PRO"),
  proTitle: tr(lang, "現在、PRO版をご利用中です", "You are currently using PRO"),
  proUsage: tr(lang, "送受信ファイル数は無制限です。", "Sent and received files are unlimited."),
  proButton: tr(lang, "PROライセンス", "PRO License"),
  freeTitle: tr(lang, "現在、無料版をご利用中です", "You are currently using the Free plan"),
  freeA: tr(lang, "本日 ", "Today: "),
  freeB: tr(lang, " ファイル使用", " files used"),
  successSuffix: tr(lang, "ファイルをiPhoneへ送りました。", " file(s) sent to iPhone."),
  receive: tr(lang, "iPhoneで「iPhone Data Sharing受信」を実行してください。", "Run “iPhone Data Sharing Receive” on your iPhone."),
  destination: tr(lang, "・初期保存先：iCloud Drive > Shortcuts > iPhone Data Sharing", "• Default save location: iCloud Drive > Shortcuts > iPhone Data Sharing"),
  change: tr(lang, "・保存先は「iPhone Data Sharing受信」ショートカット内で変更できます。", "• You can change the save location inside the “iPhone Data Sharing Receive” shortcut."),
})};
const drop=document.querySelector('#drop'),picker=document.querySelector('#file'),status=document.querySelector('#status'),planStatus=document.querySelector('#plan-status');function showStatus(message,scroll=false){status.textContent=message;if(scroll)requestAnimationFrame(()=>status.scrollIntoView({behavior:'smooth',block:'center'}))}function showUpgrade(message,url='/pro'){status.textContent='';const t=document.createElement('span');t.textContent=message+' ';const a=document.createElement('a');a.href=url;a.textContent=copy.upgrade;a.style.fontWeight='700';status.append(t,a);requestAnimationFrame(()=>status.scrollIntoView({behavior:'smooth',block:'center'}))}async function refreshPlan(){try{const s=await (await fetch('/admin/usage')).json();const card=document.querySelector('#plan-card'),badge=document.querySelector('#plan-badge'),title=document.querySelector('#plan-title'),upgrade=document.querySelector('#upgrade-link'),proLink=document.querySelector('#pro-link');if(s.plan==='pro'){badge.textContent='PRO';title.textContent=copy.proTitle;planStatus.textContent=copy.proUsage;upgrade.textContent=copy.proButton;upgrade.hidden=false;proLink.hidden=true;card.classList.add('compact')}else{badge.textContent='FREE';title.textContent=copy.freeTitle;planStatus.textContent=copy.freeA+s.usedToday+' / '+s.dailyLimit+copy.freeB;upgrade.textContent=copy.upgrade;upgrade.hidden=false;proLink.hidden=true;card.classList.remove('compact')}}catch{}}async function send(files){if(!files.length)return;showStatus(files.length+copy.sendingSuffix);try{const device=await (await fetch('/admin/device')).json();if(!device.deviceId)throw Error(copy.connect);const form=new FormData();for(const file of files)form.append('file',file);const response=await fetch('/api/outbox/'+device.deviceId,{method:'POST',body:form});const data=await response.json();if(!response.ok){if(data.code==='PRO_REQUIRED'){showUpgrade(data.error,data.upgradeUrl);return}throw Error(data.error)}showStatus(data.files.length+copy.successSuffix+String.fromCharCode(10)+copy.receive+String.fromCharCode(10)+copy.destination+String.fromCharCode(10)+copy.change,true);refreshPlan()}catch(error){showStatus(error.message,true)}}refreshPlan();drop.onclick=()=>picker.click();drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();picker.click()}};picker.onchange=()=>{send([...picker.files]);picker.value=''};function hasFiles(e){return [...(e.dataTransfer?.types||[])].includes('Files')}window.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';drop.classList.add('active')});window.addEventListener('dragleave',e=>{if(!e.relatedTarget)drop.classList.remove('active')});window.addEventListener('drop',e=>{if(!hasFiles(e))return;e.preventDefault();drop.classList.remove('active');send([...e.dataTransfer.files])});
</script>`, lang));
});
app.get("/", admin, (_req, res) => res.redirect("/transfer"));
app.get("/send-to-iphone", admin, (_req, res) => res.redirect("/transfer"));
app.post("/admin/pairing", admin, async (_req, res, next) => {
  try {
    const raw = token(); pairing.set(digest(raw), Date.now() + pairingLifetime);
    const url = `${baseUrl}/pair/${raw}`;
    res.json({ url, qr: await QRCode.toDataURL(url, { width: 300, margin: 2 }) });
  } catch (error) { next(error); }
});
app.post("/admin/unpair", admin, async (_req, res, next) => {
  try {
    pairing.clear();
    sessions.clear();
    homeScreenDevices.clear();
    const oldShortcuts = [...configuredShortcuts.values()];
    configuredShortcuts.clear();
    const outboxFiles = [...outbox.values()].map((item) => path.join(outboxDirectory, item.id));
    outbox.clear();
    for (const response of listeners.keys()) response.end();
    listeners.clear();
    await saveSessions();
    await saveOutbox();
    await saveHomeScreen();
    await Promise.all([...oldShortcuts, ...outboxFiles].map((file) => fs.unlink(file).catch(() => undefined)));
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get("/admin/pairing-state", admin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ paired: [...sessions.values()].some((session) => session.expiry > Date.now()), receivedCount });
});
app.get("/admin/device", admin, (_req, res) => {
  const id = activeDeviceId();
  res.json({ deviceId: id ?? null, homeScreenAdded: id ? homeScreenDevices.has(id) : false });
});
app.post("/phone/home-screen", phone, async (req, res, next) => {
  try {
    homeScreenDevices.add(deviceId(req));
    await saveHomeScreen();
    res.json({ homeScreenAdded: true });
  } catch (error) { next(error); }
});
app.post("/admin/outbox", admin, upload.array("file", 20), async (req, res, next) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const destination = activeDeviceId();
  if (!destination) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
    res.status(409).json({ error: "先にiPhoneとペアリングしてください" });
    return;
  }
  if (!files.length) { res.status(400).json({ error: "ファイルを選択してください" }); return; }
  const usageReservation = await reserveUsage(files.length);
  if (!usageReservation) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
    res.status(402).json(proRequiredPayload(uiLang(req)));
    return;
  }
  const inserted: OutboxItem[] = [];
  try {
    for (const file of files) {
      const id = token();
      const item: OutboxItem = {
        id,
        deviceId: destination,
        name: cleanName(multipartName(file.originalname)),
        imageType: await imageType(file.path),
        created: Date.now(),
        expires: Date.now() + outboxLifetime,
        status: "queued",
      };
      await fs.rename(file.path, path.join(outboxDirectory, id));
      outbox.set(id, item);
      inserted.push(item);
    }
    await saveOutbox();
    announce(destination);
    res.status(201).json({ files: inserted.map(outboxResponse) });
  } catch (error) { await releaseUsage(usageReservation); next(error); }
  finally { await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined))); }
});

app.post("/api/outbox/:deviceId", admin, upload.array("file", 20), async (req, res, next) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const destination = activeDeviceId();
  if (!destination || req.params.deviceId !== destination) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
    res.status(destination ? 404 : 409).json({ error: destination ? "接続先が見つかりません" : "先にiPhoneとベアリングしてください" }); return;
  }
  if (!files.length) { res.status(400).json({ error: "ファイルを選択してください" }); return; }
  const usageReservation = await reserveUsage(files.length);
  if (!usageReservation) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
    res.status(402).json(proRequiredPayload(uiLang(req)));
    return;
  }
  const inserted: OutboxItem[] = [];
  try {
    for (const file of files) {
      const id = token();
      const item: OutboxItem = { id, deviceId: destination, name: cleanName(multipartName(file.originalname)), imageType: await imageType(file.path), created: Date.now(), expires: Date.now() + outboxLifetime, status: "queued" };
      await fs.rename(file.path, path.join(outboxDirectory, id));
      outbox.set(id, item); inserted.push(item);
    }
    await saveOutbox();
    announce(destination);
    res.status(201).json({ files: inserted.map(outboxResponse) });
  } catch (error) { await releaseUsage(usageReservation); next(error); }
  finally { await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined))); }
});
app.get("/api/inbox/:deviceId", phone, (req, res) => {
  if (req.params.deviceId !== deviceId(req)) { res.status(403).json({ error: "別の端末の受信箱は開けません" }); return; }
  res.setHeader("Cache-Control", "no-store");
  res.json({ files: [...outbox.values()].filter((item) => visible(item, String(req.params.deviceId))).sort((a, b) => a.created - b.created).map(outboxResponse) });
});
app.get("/api/inbox", phone, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ deviceId: deviceId(req), files: [...outbox.values()].filter((item) => visible(item, deviceId(req))).sort((a, b) => a.created - b.created).map(outboxResponse) });
});
app.get("/phone/shortcut/inbox", phone, (req, res) => {
  const id = deviceId(req);
  const files = [...outbox.values()]
    .filter((item) => visible(item, id) && item.status === "queued")
    .sort((a, b) => a.created - b.created)
    .map((item) => ({
      name: item.name,
      // Keep the original filename in the URL as well as Content-Disposition.
      url: `${baseUrl}/api/files/${item.id}/${encodeURIComponent(item.name)}`,
    }));
  res.setHeader("Cache-Control", "no-store");
  res.json({ count: files.length, files });
});
app.get("/api/events/inbox", phone, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("event: update\ndata: {}\n\n");
  listeners.set(res, deviceId(req));
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 25_000);
  req.on("close", () => { clearInterval(heartbeat); listeners.delete(res); });
});
async function serveOutboxFile(req: Request, res: Response): Promise<void> {
  const item = outbox.get(String(req.params.fileId));
  if (!item || !visible(item, deviceId(req))) { res.status(404).json({ error: "ファイルが見つかりません" }); return; }
  const file = path.join(outboxDirectory, item.id);
  try { await fs.access(file); } catch { outbox.delete(item.id); await saveOutbox(); res.status(404).json({ error: "ファイルの実体がありません" }); return; }
  if (item.status === "queued") {
    item.status = "downloaded";
    item.expires = Math.min(item.expires, Date.now() + 15 * 60_000);
    await saveOutbox();
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", item.imageType ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Filename", encodeURIComponent(item.name));
  // res.download also emits Content-Disposition with the original filename.
  // The filename is additionally present in the request URL and X-Filename so
  // Shortcuts has multiple reliable sources for the original name.
  res.download(file, item.name);
}
app.get("/api/files/:fileId", phone, serveOutboxFile);
app.get("/api/files/:fileId/preview", phone, async (req, res) => {
  const item = outbox.get(String(req.params.fileId));
  if (!item || !item.imageType || item.deviceId !== deviceId(req) || !visible(item, deviceId(req))) { res.status(404).end(); return; }
  const file = path.join(outboxDirectory, item.id);
  try { await fs.access(file); } catch { res.status(404).end(); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.type(item.imageType).sendFile(file);
});
// Keep this catch-all filename route after /preview. Otherwise Express treats
// "preview" as a filename, serves the attachment, and marks it downloaded just
// because the inbox page tried to render a thumbnail.
app.get("/api/files/:fileId/:name", phone, serveOutboxFile);
async function removeOutboxFile(req: Request, res: Response): Promise<void> {
  const item = outbox.get(String(req.params.fileId));
  if (!item || item.deviceId !== deviceId(req) || item.expires <= Date.now()) { res.status(404).json({ error: "ファイルが見つかりません" }); return; }
  outbox.delete(item.id);
  await fs.unlink(path.join(outboxDirectory, item.id)).catch(() => undefined);
  await saveOutbox();
  announce(item.deviceId);
  res.json({ ok: true });
}
app.post("/api/files/:fileId/ack", phone, removeOutboxFile);
app.delete("/api/files/:fileId", phone, removeOutboxFile);
app.get("/pair/:token", (req, res) => {
  const lang = uiLang(req);
  const valid = (pairing.get(digest(req.params.token)) ?? 0) > Date.now();
  if (!valid) { res.status(410).send(page(tr(lang, "期限切れ", "Expired"), `<p class="lede">${tr(lang, "ペアリング用QRの有効期限が切れています。PC側で新しいQRを発行してください。", "The pairing QR code has expired. Generate a new QR code on your Mac.")}</p><section class="card"><p class="muted">${tr(lang, "メニューバーの iPhone Data Sharing から、もう一度「iPhoneを接続」を選ぶと再発行できます。", "From iPhone Data Sharing in the Mac menu bar, choose “Connect iPhone” again to generate a new one.")}</p></section>`, lang)); return; }
  const connected = JSON.stringify(`<section class="card soft"><h2>${tr(lang, "接続完了", "Connected")}</h2><p>${tr(lang, "このMacと接続しました。ショートカットを設定してください。", "Connected to this Mac. Set up the shortcuts to continue.")}</p><div class="button-row"><a class="button primary" href="/setup">${tr(lang, "ショートカットを設定", "Set up shortcuts")}</a></div></section>`);
  res.send(page(tr(lang, "ペアリング開始", "Start Pairing"), `<div id="pair-screen" class="stack"><p class="lede">${tr(lang, "このMacとのファイル送受信を許可します。同じWi‑Fi / LAN 上で安全に転送します。", "Allow file transfers with this Mac. Files are transferred securely over the same Wi‑Fi / LAN.")}</p><section class="card soft"><div class="button-row"><button id="confirm">${tr(lang, "このMacと接続する", "Connect to this Mac")}</button></div><p id="status" class="status"></p></section></div><script>document.querySelector('#confirm').onclick=async()=>{const r=await fetch(location.pathname,{method:'POST'});const j=await r.json();if(r.ok){document.querySelector('#pair-screen').innerHTML=${connected}}else{document.querySelector('#status').textContent=j.error}}</script>`, lang));

});
app.post("/pair/:token", async (req, res, next) => {
  if (!sameOrigin(req)) { res.status(403).json({ error: "Invalid origin" }); return; }
  const key = digest(req.params.token);
  const expiry = pairing.get(key);
  if (!expiry || expiry <= Date.now()) { res.status(410).json({ error: "QR の期限が切れました" }); return; }
  pairing.delete(key);
  try {
    const raw = token();
    const id = digest(raw);
    sessions.set(id, { expiry: Date.now() + sessionLifetime, deviceId: id });
    await saveSessions();
    res.setHeader("Set-Cookie", `iphone_share=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionLifetime / 1000)}`);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
function setupPage(lang: UiLang, raw?: string): string {
  const windowsCopy = windowsSetupCopy(lang);
  const windowsConfig = staticShortcutDirectory && raw
    ? `<section class="card soft">
        <h3>${escapeHtml(windowsCopy.title)}</h3>
        <p class="muted">${escapeHtml(windowsCopy.intro)}</p>
        <div class="stack mini">
          <div><strong>${escapeHtml(windowsCopy.send)}</strong><div class="input-display"><code>${escapeHtml(`${baseUrl}/phone/shortcut`)}</code></div></div>
          <div><strong>${escapeHtml(windowsCopy.receive)}</strong><div class="input-display"><code>${escapeHtml(`${baseUrl}/phone/shortcut/inbox`)}</code></div></div>
          <div><strong>${escapeHtml(windowsCopy.auth)}</strong><div class="input-display"><code>${escapeHtml(`Bearer ${raw}`)}</code></div></div>
        </div>
        <p class="muted mini">${escapeHtml(windowsCopy.note)}</p>
      </section>`
    : "";
  return page(tr(lang, "送受信設定", "Transfer Setup"), `<p class="lede">${tr(lang, "このiPhoneで使うショートカットを設定します。初回だけ追加すれば、以後はQR不要でスムーズに送受信できます。", "Set up the shortcuts used on this iPhone. After the initial setup, you can send and receive without scanning the QR code again.")}</p>
${windowsConfig}
<div class="grid two"><section class="card soft"><h2>${tr(lang, "Macに送る", "Send to Mac")}</h2><p>${tr(lang, "写真・動画・書類の共有シートから、Macへ直接送信するためのショートカットです。", "Use this shortcut from the iPhone share sheet to send photos, videos, and documents directly to your Mac.")}</p><p class="muted mini">${tr(lang, "共有シートはON、入力は「画像・メディア・ファイル」をあらかじめ有効にした状態で生成します。", "The shortcut is generated with Share Sheet enabled and accepts images, media, and files.")}</p><div class="button-row"><a class="button primary" id="install-send" href="/install/one-click.shortcut">${tr(lang, "「Macに送る」を取得", "Get “Send to Mac”")}</a></div><p id="install-send-status" class="status hint mini" aria-live="polite"></p></section>
<section class="card soft"><h2>${tr(lang, "iPhone Data Sharing受信", "iPhone Data Sharing Receive")}</h2><p>${tr(lang, "Macの受信箱に届いているファイルをまとめて取得し、「ファイル」アプリへ保存します。写真アプリは使いません。", "Downloads all pending files from your Mac and saves them to the Files app. It does not use the Photos app.")}</p><p class="muted mini"><strong>${tr(lang, "初期保存先：", "Default save location:")}</strong> iCloud Drive &gt; Shortcuts &gt; iPhone Data Sharing. ${tr(lang, "保存先はあとから変更できます。「ショートカット」Appで「iPhone Data Sharing受信」を編集し、「ファイルを保存」アクションの保存先を希望のフォルダへ変更してください。", "You can change this later by editing “iPhone Data Sharing Receive” in the Shortcuts app and changing the destination of the Save File action.")}</p><p class="muted mini">${tr(lang, "こちらも共有シートをONにし、「画像・メディア・ファイル」を有効にした状態で生成します。", "This shortcut is also generated with Share Sheet enabled for images, media, and files.")}</p><div class="button-row"><a class="button primary" id="install-receive" href="/install/receive.shortcut">${tr(lang, "「iPhone Data Sharing受信」を取得", "Get “iPhone Data Sharing Receive”")}</a></div><p id="install-receive-status" class="status hint mini" aria-live="polite"></p></section></div>
<section class="card"><h3>${tr(lang, "補足", "Notes")}</h3><div class="list mini"><div class="feature"><div class="badge">✓</div><div><strong>${tr(lang, "追加方法", "How to add")}</strong><br><span class="muted">${tr(lang, ".shortcut を保存したあと、「ファイル」アプリから開いて「ショートカットに追加」を選択してください。", "After saving the .shortcut file, open it from Files and choose Add Shortcut.")}</span></div></div><div class="feature"><div class="badge">✓</div><div><strong>${tr(lang, "初回許可", "First-run permissions")}</strong><br><span class="muted">${tr(lang, "ネットワークやファイル保存の許可が表示された場合は、継続利用できる許可を選んでください。", "If network or file-saving permission prompts appear, choose the option that allows continued use.")}</span></div></div><div class="feature"><div class="badge">⌂</div><div><strong>${tr(lang, "ホーム画面アイコン", "Home Screen icon")}</strong><br><span class="muted">${tr(lang, "「iPhone Data Sharing受信」をホーム画面へ追加するときは、iPhone Data Sharingの画像を選択してください。iPhoneから下のリンクを開き、画像を長押しして写真またはファイルへ保存できます。", "When adding “iPhone Data Sharing Receive” to the Home Screen, you can use the iPhone Data Sharing image. Open the link below on your iPhone, then touch and hold the image to save it.")}</span><br><a href="/app-icon.png" target="_blank" rel="noopener">${tr(lang, "iPhoneでiPhone Data Sharingアイコンを表示", "Open the iPhone Data Sharing icon on iPhone")}</a></div></div><div class="feature"><div class="badge">→</div><div><strong>${tr(lang, "受信箱の管理", "Manage inbox")}</strong><br><a href="/filedrop/inbox">${tr(lang, "未受信ファイルを確認する", "View pending files")}</a></div></div></div><p class="muted mini">${tr(lang, "ショートカット App がない場合は", "If you do not have the Shortcuts app,")} <a href="https://apps.apple.com/app/shortcuts/id915249334">${tr(lang, "App Store からインストール", "install it from the App Store")}</a>${tr(lang, "してください。", ".")}</p></section>
<script>const installSend=document.querySelector('#install-send'),installReceive=document.querySelector('#install-receive'),installSendStatus=document.querySelector('#install-send-status'),installReceiveStatus=document.querySelector('#install-receive-status');installSend.addEventListener('click',()=>{installSendStatus.textContent='${tr(lang, "ファイル生成に少し時間がかかることがあります。準備中…", "Generating the shortcut may take a moment. Preparing…")}';});installReceive.addEventListener('click',()=>{installReceiveStatus.textContent='${tr(lang, "受信用ファイルを準備中…", "Preparing the receive shortcut…")}';});</script>`, lang);
}
app.get("/setup", phone, (req, res) => res.send(setupPage(uiLang(req), sessionToken(req)!)));
app.get("/setup-guide", admin, async (req, res, next) => {
  try {
    const lang = uiLang(req);
    const setupUrl = `${baseUrl}/setup`;
    const iconUrl = `${baseUrl}/app-icon.png`;
    const [setupQr, iconQr] = await Promise.all([QRCode.toDataURL(setupUrl,{width:128,margin:1}),QRCode.toDataURL(iconUrl,{width:128,margin:1})]);
    res.send(page(tr(lang, "送受信設定情報", "Transfer Setup Information"), `<p class="lede">${tr(lang, "ペアリング済みのiPhoneで、次の設定ページを開いてショートカットを追加してください。", "On your paired iPhone, open the setup page below and add the shortcuts.")}</p>
<section class="card soft"><div class="guide-qr-row"><div><h3>${tr(lang, "設定ページURL", "Setup page URL")}</h3><div class="input-display"><code>${escapeHtml(setupUrl)}</code></div><p class="muted mini">${tr(lang, "このURLは、同じLANに接続したiPhoneからiPhone Data Sharingの初期設定を開くためのローカルアドレスです。Safariで開くと「Macに送る」「iPhone Data Sharing受信」のショートカットを取得できます。", "This local URL opens iPhone Data Sharing setup from an iPhone on the same LAN. Open it in Safari to get the “Send to Mac” and “iPhone Data Sharing Receive” shortcuts.")}</p></div><img class="guide-qr" src="${setupQr}" alt="${tr(lang, "設定ページURLのQRコード", "QR code for the setup page URL")}"></div></section>
<div class="grid two"><section class="card"><h3>${tr(lang, "Macに送る", "Send to Mac")}</h3><p class="muted">${tr(lang, "iPhoneの写真・ファイル・PDFなどを共有シートから選び、同じLAN上のMacへ直接送信します。初回設定後は、共有メニューから「Macに送る」を選ぶだけで利用できます。", "Choose photos, files, PDFs, and other items from the iPhone share sheet and send them directly to your Mac on the same LAN. After setup, simply choose “Send to Mac” from the Share menu.")}</p></section><section class="card"><h3>${tr(lang, "iPhone Data Sharing受信", "iPhone Data Sharing Receive")}</h3><p class="muted">${tr(lang, "Macから届いた未受信ファイルをまとめて取得し、「ファイル」アプリへ保存します。", "Downloads all pending files sent from your Mac and saves them to the Files app.")}</p><p class="muted mini"><strong>${tr(lang, "初期保存先：", "Default save location:")}</strong> iCloud Drive &gt; Shortcuts &gt; iPhone Data Sharing. ${tr(lang, "あとから「ショートカット」Appで「iPhone Data Sharing受信」を編集し、「ファイルを保存」アクションの保存先を変更できます。", "You can change it later by editing “iPhone Data Sharing Receive” in Shortcuts and changing the destination of the Save File action.")}</p></section></div>
<section class="card"><div class="guide-qr-row"><div><h3>${tr(lang, "ホーム画面へ追加する場合", "Add to Home Screen")}</h3><p class="muted">${tr(lang, "iPhoneのショートカット App から「iPhone Data Sharing受信」→共有→「ホーム画面に追加」を選んでください。アイコンを使用する場合は、iPhone Data Sharing の画像をご使用いただけます。iPhoneからも下のURLを直接開けます。", "In the iPhone Shortcuts app, open “iPhone Data Sharing Receive” → Share → Add to Home Screen. If you want to use an icon, you can use the iPhone Data Sharing image. You can also open the URL below directly on your iPhone.")}</p><div class="button-row"><a class="button ghost" href="${escapeHtml(iconUrl)}" target="_blank" rel="noopener">${tr(lang, "iPhoneでiPhone Data Sharingアイコンを表示", "Open the iPhone Data Sharing icon on iPhone")}</a></div><div class="link-url-gap"></div><div class="input-display"><code>${escapeHtml(iconUrl)}</code></div><p class="muted mini">${tr(lang, "iPhoneで開いた場合は、画像を長押しして保存してからホーム画面アイコンに指定してください。", "On iPhone, touch and hold the image to save it, then choose it as the Home Screen icon.")}</p></div><img class="guide-qr" src="${iconQr}" alt="${tr(lang, "iPhone Data SharingアイコンURLのQRコード", "QR code for the iPhone Data Sharing icon URL")}"></div></section>`, lang));
  } catch (error) { next(error); }
});

app.post("/phone/setup", phone, async (req, res, next) => {
  try {
    const raw = sessionToken(req)!;
    const lang = uiLang(req);
    // Generate serially. This makes send/receive signing deterministic and rules out
    // any cross-talk in the macOS Shortcuts signing service during simultaneous builds.
    const sendFile = await configuredShortcut(raw, "send", lang);
    await shortcutManifestForServing(sendFile, "send");
    const receiveFile = await configuredShortcut(raw, "receive", lang);
    await shortcutManifestForServing(receiveFile, "receive");
    console.log("[shortcut-setup-ready]", {
      send: path.basename(sendFile),
      receive: path.basename(receiveFile),
      revision: shortcutRevision,
    });
    res.json({ ok: true, revision: shortcutRevision });
  } catch (error) { next(error); }
});
app.get("/filedrop/inbox", phonePage, (req, res) => {
  const lang = uiLang(req);
  res.send(page(tr(lang, "iPhone Data Sharing受信箱", "iPhone Data Sharing Inbox"), `<p class="lede">${tr(lang, "このページは、未受信ファイルの確認と削除を行う管理画面です。通常の受信は iPhone の「iPhone Data Sharing受信」ショートカットを実行してください。", "This page lets you review and delete pending files. For normal receiving, run the “iPhone Data Sharing Receive” shortcut on your iPhone.")}</p><section class="card soft"><p id="status" class="status">${tr(lang, "現在、受信できるファイルはありません。", "There are no pending files right now.")}<br>${tr(lang, "新しいファイルは自動表示されます。", "New files will appear automatically.")}</p></section><div id="files" class="file-grid"></div><script>
const copy=${JSON.stringify({
  empty: tr(lang, "現在、受信できるファイルはありません。", "There are no pending files right now."),
  waiting: tr(lang, "新しいファイルは自動表示されます。", "New files will appear automatically."),
  remove: tr(lang, "削除", "Delete"),
  failed: tr(lang, "削除できませんでした", "Could not delete the file."),
})};const list=document.querySelector("#files"),status=document.querySelector("#status");async function remove(id){const response=await fetch("/api/files/"+id,{method:"DELETE"});if(response.ok)await refresh();else status.textContent=copy.failed}function card(file){const preview=file.previewUrl?'<img class="thumb" src="'+file.previewUrl+'" alt="">':'<div class="thumb file-icon">▣</div>';return '<div class="file-card">'+preview+'<div class="file-name">'+file.name+'</div><button class="secondary" onclick="remove(\\''+file.id+'\\')">'+copy.remove+'</button></div>'}async function refresh(){const response=await fetch("/api/inbox");if(!response.ok)return;const data=await response.json();const current=data.files||[];list.innerHTML=current.map(card).join("");status.innerHTML=current.length?"":copy.empty+"<br>"+copy.waiting}refresh();const events=new EventSource("/api/events/inbox");events.addEventListener("update",refresh);
</script>`, lang));
});
app.get("/send", phone, (req, res) => {
  const lang = uiLang(req);
  res.send(page(tr(lang, "iPhoneからMacへ送信", "Send from iPhone to Mac"), `<p class="lede">${tr(lang, "このLAN内のMacへファイルを送信します。", "Send files to your Mac on this LAN.")}</p><section class="card soft"><div class="stack"><input id="files" type="file" multiple><div class="button-row"><button id="send">${tr(lang, "PCへ送信する", "Send to Mac")}</button></div><p id="status" class="status"></p></div></section><script>
const copy=${JSON.stringify({
  sending: tr(lang, "送信中…", "Sending…"),
  pro: tr(lang, "PRO版を見る", "View PRO"),
  failed: tr(lang, "送信できませんでした", "Could not send the files"),
  success: tr(lang, " 件を PC に保存しました", " file(s) saved to Mac"),
  network: tr(lang, "接続できません。同じ Wi‑Fi / LAN を確認してください。", "Could not connect. Make sure both devices are on the same Wi‑Fi / LAN."),
})};document.querySelector('#send').onclick=async()=>{const files=document.querySelector('#files').files;if(!files.length)return;const form=new FormData();for(const file of files)form.append('file',file);const status=document.querySelector('#status');status.textContent=copy.sending;try{const r=await fetch('/phone/upload',{method:'POST',body:form});const j=await r.json();if(!r.ok){if(j.code==='PRO_REQUIRED'){status.textContent='';const t=document.createElement('span');t.textContent=j.error+' ';const a=document.createElement('a');a.href=j.upgradeUrl||'/pro';a.textContent=copy.pro;status.append(t,a);return}throw Error(j.error||copy.failed)}status.textContent=j.files.length+copy.success}catch(e){status.textContent=e.message||copy.network}}
</script>`, lang));
});
app.post("/phone/upload", phone, upload.array("file", 20), async (req, res, next) => {
  const received = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!received.length) { res.status(400).json({ error: "ファイルを選択してください" }); return; }
  const usageReservation = await reserveUsage(received.length);
  if (!usageReservation) {
    await Promise.all(received.map((file) => fs.unlink(file.path).catch(() => undefined)));
    res.status(402).json(proRequiredPayload(uiLang(req)));
    return;
  }
  try {
    const saved = [];
    for (const file of received) saved.push(await moveExclusive(file.path, multipartName(file.originalname)));
    res.status(201).json({ files: saved });
  } catch (error) { await releaseUsage(usageReservation); next(error); }
  finally { await Promise.all(received.map((file) => fs.unlink(file.path).catch(() => undefined))); }
});

app.post("/phone/shortcut/permit", phone, async (req, res, next) => {
  try {
    const usage = currentUsage();
    if (licenseState.plan !== "pro" && usage.count >= freeDailyLimit) {
      res.status(402).json(proRequiredPayload(uiLang(req)));
      return;
    }
    const permit = token();
    transferPermits.set(permit, {
      deviceId: deviceId(req),
      expires: Date.now() + 15 * 60_000,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ permit, ...licenseSummary() });
  } catch (error) { next(error); }
});

app.post("/phone/shortcut", phone, (req, res, next) => {
  if (req.is("multipart/form-data")) upload.single("file")(req, res, next);
  else next();
}, async (req, res, next) => {
  const permitValue = req.get("x-usage-permit") ?? "";
  const permit = transferPermits.get(permitValue);
  if (!permit || permit.expires <= Date.now() || permit.deviceId !== deviceId(req)) {
    if (req.file) await fs.unlink(req.file.path).catch(() => undefined);
    res.status(402).json({
      ...proRequiredPayload(),
      error: "送信許可を確認できません。最新の「Macに送る」ショートカットを取り込み直して、もう一度お試しください。",
    });
    return;
  }
  // A permit authorizes one file only. Consuming it also prevents accidental
  // double submissions from counting or saving the same file twice.
  transferPermits.delete(permitValue);
  const usageReservation = await reserveUsage(1);
  if (!usageReservation) {
    if (req.file) await fs.unlink(req.file.path).catch(() => undefined);
    res.status(402).json(proRequiredPayload(uiLang(req)));
    return;
  }
  if (req.file) {
    try {
      const saved = await moveExclusive(req.file.path, multipartName(req.file.originalname));
      res.status(201).json({ files: [saved] });
    }
    catch (error) {
      await releaseUsage(usageReservation);
      next(error);
    }
    finally { await fs.unlink(req.file.path).catch(() => undefined); }
    return;
  }
  if (req.is("multipart/form-data")) {
    await releaseUsage(usageReservation);
    res.status(400).json({ error: "file フィールドが必要です" });
    return;
  }
  const suppliedName = cleanName(req.get("x-filename") ?? "");
  const rawType = req.get("content-type") ?? "";
  const genericName = `shortcut-file${extensionForMime(rawType)}`;
  const requestedName = suppliedName && suppliedName !== "shortcut-file" && suppliedName !== "file"
    ? suppliedName
    : genericName;
  const temp = path.join(scratch, token());
  let size = 0;
  try {
    await pipeline(req, new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(size > maxFileSize ? new Error("SIZE_LIMIT") : null, chunk);
      },
    }), createWriteStream(temp, { flags: "wx" }));
    if (!size) {
      await releaseUsage(usageReservation);
      res.status(400).json({ error: "空のファイルです" });
      return;
    }
    const detectedType = await imageType(temp);
    const finalName = ensureExtension(requestedName, rawType, detectedType);
    const saved = await moveExclusive(temp, finalName);
    res.status(201).json({ files: [saved] });
  } catch (error) {
    await releaseUsage(usageReservation);
    if ((error as Error).message === "SIZE_LIMIT") { res.status(413).json({ error: "ファイルサイズの上限を超えました" }); return; }
    next(error);
  } finally { await fs.unlink(temp).catch(() => undefined); }
});
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) { res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: "ファイル数またはサイズの上限を超えました" }); return; }
  console.error(error);
  if (!res.headersSent) res.status(500).json({ error: "処理に失敗しました" });
});
async function expireOutbox(now: number): Promise<void> {
  let changed = false;
  for (const item of outbox.values()) if (item.expires <= now) {
    outbox.delete(item.id); changed = true;
    await fs.unlink(path.join(outboxDirectory, item.id)).catch(() => undefined);
  }
  if (changed) await saveOutbox();
}
await expireOutbox(Date.now());
const cleanup = setInterval(async () => {
  const now = Date.now();
  for (const [key, expiry] of pairing) if (expiry <= now) pairing.delete(key);
  let removedSession = false;
  for (const [key, session] of sessions) if (session.expiry <= now) { sessions.delete(key); removedSession = true; }
  if (removedSession) await saveSessions();
  for (const [key, permit] of transferPermits) {
    if (permit.expires <= now) transferPermits.delete(key);
  }
  await expireOutbox(now);
}, 60_000);
cleanup.unref();
if (staticShortcutDirectory) {
  for (const kind of ["send", "receive"] as ShortcutKind[]) {
    for (const lang of ["ja", "en", "zh", "ko", "es", "fr", "de"] as UiLang[]) {
      const candidate = path.join(staticShortcutDirectory, `${kind}-${lang}.shortcut`);
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile() || stat.size <= 0) throw new Error("empty");
      } catch {
        console.warn("[shortcut-static-missing]", { kind, lang, candidate });
      }
    }
  }
}

app.listen(port, "0.0.0.0", () => {
  console.log(`PC 画面: http://localhost:${port}`);
  console.log(`iPhone 接続先: ${baseUrl}`);
  console.log(`保存先: ${downloads}`);
  const license = licenseSummary();
  console.log(`ライセンス: ${license.plan === "pro" ? "PRO" : `FREE (${license.usedToday}/${freeDailyLimit})`}`);
});
if (process.env.AGENT_PARENT_PIPE === "1") {
  process.stdin.resume();
  process.stdin.once("end", () => process.exit(0));
}
if (process.env.AGENT_PARENT_PID) {
  const parent = Number(process.env.AGENT_PARENT_PID);
  if (!Number.isSafeInteger(parent) || parent < 2) throw new Error("Invalid parent process ID");
  const watchdog = setInterval(() => {
    try { process.kill(parent, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") process.exit(0); }
  }, 2_000);
  watchdog.unref();
}
