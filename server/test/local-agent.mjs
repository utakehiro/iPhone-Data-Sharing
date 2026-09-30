import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Script } from "node:vm";

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has("accept-language")) headers.set("accept-language", "ja");
  return nativeFetch(input, { ...init, headers });
};

function checkPageScripts(html) {
  for (const [, source] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(source);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-share-test-"));
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const publicBase = `http://192.0.2.10:${port}`;
const staticShortcutDirectory = path.resolve(import.meta.dirname, "../../windows-agent/resources/shortcuts");
function startAgent(extraEnv = {}) {
  const process = spawn(globalThis.process.env.TEST_AGENT_NODE ?? globalThis.process.execPath, [globalThis.process.env.TEST_AGENT_SCRIPT ?? "dist/local-agent.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...globalThis.process.env, PORT: String(port), PUBLIC_BASE_URL: publicBase, DOWNLOAD_DIR: path.join(root, "downloads"), TEMP_DIR: path.join(root, "temp"), DATA_DIR: path.join(root, "data"), STATIC_SHORTCUT_DIR: staticShortcutDirectory, ...extraEnv },
    stdio: "pipe",
  });
  if (globalThis.process.env.TEST_AGENT_LOG === "1") process.stderr.pipe(globalThis.process.stderr);
  return process;
}
let child = startAgent();

try {
  let ready = false;
  for (let n = 0; n < 50; n++) {
    try { ready = (await fetch(`${base}/health`)).ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "agent starts");
  assert.deepEqual(await (await fetch(`${base}/admin/pairing-state`)).json(), { paired: false, receivedCount: 0 });
  assert.equal((await fetch(`${base}/setup`)).status, 401);
  const adminPage = await (await fetch(base)).text();
  checkPageScripts(adminPage);
  assert.match(adminPage, /<h1>PCからiPhoneへ送信<\/h1>/);
  assert.match(adminPage, /@media \(max-width:720px\),\(hover:none\) and \(pointer:coarse\) and \(max-width:1024px\)\{\.language-switch\{display:none\}/);
  assert.match(adminPage, /<nav class="language-switch" aria-label="Language">/, "desktop language switch remains available");
  assert.match(adminPage, /window\.addEventListener\('dragover'/);
  assert.match(adminPage, /window\.addEventListener\('drop'/);
  assert.match(adminPage, /send\(\[\.\.\.e\.dataTransfer\.files\]\)/);
  assert.doesNotMatch(adminPage, /受信用 QR/);
  const guidePage = await (await fetch(`${base}/setup-guide`)).text();
  checkPageScripts(guidePage);
  assert.match(guidePage, /<h1>送受信設定情報<\/h1>/);
  assert.match(guidePage, /Macに送る/);
  assert.match(guidePage, /iPhone Data Sharing受信/);
  assert.match(guidePage, /ホーム画面へ追加/);
  const appIcon = await fetch(`${base}/app-icon.png`);
  assert.equal(appIcon.status, 200);
  assert.match(appIcon.headers.get("content-type"), /image\/png/);
  const sendInstaller = await fetch(`${base}/install/send-to-pc.shortcut`);
  assert.equal(sendInstaller.status, 401, "shortcut installers require a paired iPhone");
  assert.equal((await fetch(`${base}/install/save-to-photos.shortcut`)).status, 404);
  const denied = await fetch(`${base}/phone/upload`, { method: "POST" });
  assert.equal(denied.status, 401);
  assert.equal((await fetch(`${base}/inbox`)).status, 404);
  const unauthenticatedHome = await fetch(`${base}/filedrop/inbox`);
  assert.equal(unauthenticatedHome.status, 401);
  assert.match(unauthenticatedHome.headers.get("content-type"), /text\/html/);
  assert.match(await unauthenticatedHome.text(), /認証を更新する必要があります/);
  const qr = await fetch(`${base}/admin/pairing`, { method: "POST" });
  assert.equal(qr.status, 200);
  const pair = await qr.json();
  assert.match(pair.qr, /^data:image\/png;base64,/);
  const pairingUrl = `${base}${new URL(pair.url).pathname}`;
  const pairingPage = await (await fetch(pairingUrl)).text();
  assert.match(pairingPage, /このMacと接続する/);
  assert.match(pairingPage, /ショートカットを設定/);
  assert.match(pairingPage, /href=\\"\/setup\\"/);
  const paired = await fetch(pairingUrl, { method: "POST" });
  assert.equal(paired.status, 200);
  assert.equal((await fetch(pairingUrl, { method: "POST" })).status, 410);
  const cookie = paired.headers.get("set-cookie").split(";")[0];
  assert.deepEqual(await (await fetch(`${base}/admin/pairing-state`)).json(), { paired: true, receivedCount: 0 });
  assert.match(await (await fetch(`${base}/setup`, { headers: { cookie } })).text(), /「Macに送る」を取得/);
  const phoneSetup = await fetch(`${base}/phone/setup`, { method: "POST", headers: { cookie } });
  assert.equal(phoneSetup.status, 200, await phoneSetup.text());
  const chosenDirectory = path.join(root, "chosen");
  await fs.mkdir(chosenDirectory);
  assert.deepEqual(await (await fetch(`${base}/admin/download-directory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: chosenDirectory }) })).json(), { directory: chosenDirectory });
  assert.deepEqual(await (await fetch(`${base}/admin/download-directory`)).json(), { directory: chosenDirectory });
  const setupPage = await (await fetch(`${base}/setup`, { headers: { cookie } })).text();
  checkPageScripts(setupPage);
  assert.match(setupPage, /<h1>送受信設定<\/h1>/);
  assert.match(setupPage, /ホーム画面へ追加/);
  assert.match(setupPage, /「Macに送る」を取得/);
  assert.match(setupPage, /「iPhone Data Sharing受信」を取得/);
  assert.match(setupPage, /初回許可/);
  assert.doesNotMatch(setupPage, /ダウンロード中…/);
  assert.doesNotMatch(setupPage, /写真に保存|photo-permission/);
  assert.match(setupPage, /apps\.apple\.com\/app\/shortcuts/);
  const homePage = await fetch(`${base}/filedrop/inbox`, { headers: { cookie } });
  assert.equal(homePage.status, 200);
  assert.match(await homePage.text(), /iPhone Data Sharing受信箱/);
  const homeCookie = cookie;
  assert.equal((await fetch(`${base}/api/inbox`, { headers: { cookie: homeCookie } })).status, 200);
  const installer = await fetch(`${base}/install/one-click.shortcut`, { headers: { cookie } });
  assert.equal(installer.status, 200);
  assert.match(decodeURIComponent(installer.headers.get("content-disposition")), /Macに送る/);
  assert.ok((await installer.arrayBuffer()).byteLength > 1000);
  assert.equal((await fetch(`${base}/install/one-click.shortcut`)).status, 401);
  const storedSessions = await fs.readFile(path.join(root, "data", "sessions.json"), "utf8");
  assert.doesNotMatch(storedSessions, /iphone_share=/);
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  child = startAgent();
  let restarted = false;
  for (let n = 0; n < 50; n++) {
    try { restarted = (await fetch(`${base}/send`, { headers: { cookie } })).ok; } catch { /* starting */ }
    if (restarted) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(restarted, "pairing survives agent restart");
  assert.equal((await fetch(`${base}/api/inbox`, { headers: { cookie: homeCookie } })).status, 200, "home-screen authentication survives restart");
  const device = await (await fetch(`${base}/admin/device`)).json();
  assert.match(device.deviceId, /^[0-9a-f]{64}$/);
  assert.equal(device.homeScreenAdded, false);
  assert.match(await (await fetch(`${base}/transfer`)).text(), /iPhone Data Sharing受信」を実行/);
  assert.equal((await fetch(`${base}/phone/home-screen`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${base}/phone/home-screen`, { method: "POST", headers: { cookie } })).status, 200);
  assert.equal((await (await fetch(`${base}/admin/device`)).json()).homeScreenAdded, true);
  const batch = new FormData();
  batch.append("file", new Blob(["one"]), "one.txt");
  batch.append("file", new Blob(["two"]), "two.txt");
  const enqueued = await fetch(`${base}/api/outbox/${device.deviceId}`, { method: "POST", body: batch });
  assert.equal(enqueued.status, 201);
  const queued = (await enqueued.json()).files;
  assert.equal(queued.length, 2);
  assert.equal(queued[0].status, "queued");
  assert.equal((await fetch(`${base}/api/files/${queued[0].id}`)).status, 401, "a stranger cannot download queued files");
  assert.equal((await fetch(`${base}/api/inbox/${"0".repeat(64)}`, { headers: { cookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/inbox`, { headers: { cookie } })).status, 200);
  const eventsController = new AbortController();
  const events = await fetch(`${base}/api/events/inbox`, { headers: { cookie }, signal: eventsController.signal });
  assert.match(events.headers.get("content-type"), /text\/event-stream/);
  eventsController.abort();
  const receivedFile = await fetch(`${base}/api/files/${queued[0].id}/one.txt`, { headers: { cookie } });
  assert.equal(await receivedFile.text(), "one");
  assert.match(receivedFile.headers.get("content-disposition") ?? "", /one\.txt/);
  assert.equal((await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json()).files.find((item) => item.id === queued[0].id).status, "downloaded");
  assert.equal((await fetch(`${base}/admin/history`)).status, 404, "transfer history is not retained");
  assert.equal((await fetch(`${base}/api/files/${queued[0].id}/ack`, { method: "POST", headers: { cookie } })).status, 200);
  assert.equal((await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json()).files.length, 1);
  const oldBatch = new FormData();
  oldBatch.append("file", new Blob(["expired"]), "expired.txt");
  const expiring = (await (await fetch(`${base}/api/outbox/${device.deviceId}`, { method: "POST", body: oldBatch })).json()).files[0];
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  const storedOutboxFile = path.join(root, "data", "outbox.json");
  const storedOutbox = JSON.parse(await fs.readFile(storedOutboxFile, "utf8"));
  storedOutbox.find((item) => item.id === expiring.id).expires = Date.now() - 1;
  await fs.writeFile(storedOutboxFile, JSON.stringify(storedOutbox));
  child = startAgent();
  for (let n = 0; n < 50; n++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json()).files[0].name, "two.txt", "outbox survives restart");
  assert.equal((await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json()).files.some((item) => item.id === expiring.id), false);
  await assert.rejects(fs.stat(path.join(root, "data", "outbox", expiring.id)), { code: "ENOENT" });
  assert.equal((await (await fetch(`${base}/admin/device`)).json()).homeScreenAdded, true, "home screen choice survives restart");
  const inboxPage = await (await fetch(`${base}/filedrop/inbox`, { headers: { cookie } })).text();
  checkPageScripts(inboxPage);
  assert.match(inboxPage, /<h1>iPhone Data Sharing受信箱<\/h1>/);
  assert.match(inboxPage, /現在、受信できるファイルはありません。/);
  assert.match(inboxPage, /削除/);
  assert.match(inboxPage, /method:"DELETE"/);
  assert.doesNotMatch(inboxPage, /setTimeout\(\(\)=>mark|function mark/);
  assert.doesNotMatch(inboxPage, /すべて保存する/);
  assert.match(inboxPage, /file-grid/);
  assert.match(inboxPage, /previewUrl/);
  assert.match(inboxPage, /EventSource/);
  assert.match(inboxPage, /EventSource\("\/api\/events\/inbox"\)/);
  assert.doesNotMatch(inboxPage, /写真に保存|photo-permission|filedrop-photo/);
  assert.equal((await fetch(`${base}/api/files/${queued[1].id}`, { method: "DELETE", headers: { cookie } })).status, 200);
  assert.equal((await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json()).files.some((item) => item.id === queued[1].id), false);
  await assert.rejects(fs.stat(path.join(root, "data", "outbox", queued[1].id)), { code: "ENOENT" });
  assert.deepEqual(await (await fetch(`${base}/admin/download-directory`)).json(), { directory: chosenDirectory });
  assert.equal((await fetch(`${base}/inbox`, { headers: { cookie }, redirect: "manual" })).status, 404);
  const form = new FormData();
  form.append("file", new Blob(["from iPhone"]), "photo.txt");
  const sent = await fetch(`${base}/phone/upload`, { method: "POST", headers: { cookie }, body: form });
  assert.equal(sent.status, 201);
  assert.equal((await sent.json()).files[0], "photo.txt");
  assert.equal(await fs.readFile(path.join(chosenDirectory, "photo.txt"), "utf8"), "from iPhone");
  assert.deepEqual(await (await fetch(`${base}/admin/pairing-state`)).json(), { paired: true, receivedCount: 1 });
  const second = new FormData();
  second.append("file", new Blob(["again"]), "photo.txt");
  const duplicated = await fetch(`${base}/phone/upload`, { method: "POST", headers: { cookie }, body: second });
  assert.equal((await duplicated.json()).files[0], "photo (1).txt");
  const rawPermit = (await (await fetch(`${base}/phone/shortcut/permit`, { method: "POST", headers: { cookie } })).json()).permit;
  const shortcut = await fetch(`${base}/phone/shortcut`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "x-filename": "shortcut.txt", "x-usage-permit": rawPermit },
    body: "from Shortcut",
  });
  assert.equal(shortcut.status, 201);
  assert.equal(await fs.readFile(path.join(chosenDirectory, "shortcut.txt"), "utf8"), "from Shortcut");
  const shortcutForm = new FormData();
  shortcutForm.append("file", new Blob(["shortcut form"]), "フォーム.txt");
  const formPermit = (await (await fetch(`${base}/phone/shortcut/permit`, { method: "POST", headers: { cookie } })).json()).permit;
  const formSent = await fetch(`${base}/phone/shortcut`, { method: "POST", headers: { cookie, "x-usage-permit": formPermit }, body: shortcutForm });
  assert.equal(formSent.status, 201);
  assert.equal(await fs.readFile(path.join(chosenDirectory, "フォーム.txt"), "utf8"), "shortcut form");
  const sendPage = await (await fetch(`${base}/send-to-iphone`)).text();
  assert.match(sendPage, /multiple hidden/);
  assert.doesNotMatch(sendPage, /受信用 QR/);
  const image = new FormData();
  image.append("file", new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])], { type: "image/png" }), "photo.png");
  const imageResponse = await fetch(`${base}/api/outbox/${device.deviceId}`, { method: "POST", body: image });
  assert.equal(imageResponse.status, 201);
  const imageItem = (await imageResponse.json()).files[0];
  assert.equal(imageItem.type, "image");
  assert.match(imageItem.previewUrl, /\/api\/files\/.+\/preview/);
  assert.equal((await fetch(`${base}${imageItem.fileUrl}`)).status, 401);
  const preview = await fetch(`${base}${imageItem.previewUrl}`, { headers: { cookie } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type"), /image\/png/);
  assert.equal(preview.headers.get("content-disposition"), null, "preview is rendered inline, not downloaded");
  assert.equal((await (await fetch(`${base}/api/inbox`, { headers: { cookie } })).json()).files.find((item) => item.id === imageItem.id).status, "queued", "preview does not mark the file downloaded");
  assert.match((await fetch(`${base}${imageItem.fileUrl}`, { headers: { cookie } })).headers.get("content-type"), /image\/png/);
  const usageBeforeInvalidUploads = (await (await fetch(`${base}/admin/usage`)).json()).usedToday;
  const emptyPermit = (await (await fetch(`${base}/phone/shortcut/permit`, { method: "POST", headers: { cookie } })).json()).permit;
  const emptyUpload = await fetch(`${base}/phone/shortcut`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "x-filename": "empty.txt", "x-usage-permit": emptyPermit },
    body: "",
  });
  assert.equal(emptyUpload.status, 400);
  assert.equal((await (await fetch(`${base}/admin/usage`)).json()).usedToday, usageBeforeInvalidUploads, "an empty upload does not consume usage");
  const missingFilePermit = (await (await fetch(`${base}/phone/shortcut/permit`, { method: "POST", headers: { cookie } })).json()).permit;
  const missingFileForm = new FormData();
  missingFileForm.append("not-file", "value");
  const missingFileUpload = await fetch(`${base}/phone/shortcut`, {
    method: "POST",
    headers: { cookie, "x-usage-permit": missingFilePermit },
    body: missingFileForm,
  });
  assert.equal(missingFileUpload.status, 400);
  assert.equal((await (await fetch(`${base}/admin/usage`)).json()).usedToday, usageBeforeInvalidUploads, "a multipart request without a file does not consume usage");
  const unpair = await fetch(`${base}/admin/unpair`, { method: "POST" });
  assert.equal(unpair.status, 200);
  assert.deepEqual(await (await fetch(`${base}/admin/pairing-state`)).json(), { paired: false, receivedCount: 4 });
  assert.equal((await fetch(`${base}/health`)).status, 200, "unpair leaves agent running");
  assert.equal((await fetch(`${base}/send`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${base}/api/inbox`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${base}/api/inbox`, { headers: { cookie: homeCookie } })).status, 401);
  assert.equal((await (await fetch(`${base}/admin/device`)).json()).homeScreenAdded, false);
  assert.equal((await fetch(`${base}/api/files/${queued[1].id}`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${base}/phone/shortcut`, { method: "POST", headers: { cookie }, body: "x" })).status, 401);
  assert.equal((await fetch(`${base}/install/one-click.shortcut`, { headers: { cookie } })).status, 401);
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  child = startAgent();
  for (let n = 0; n < 50; n++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await fetch(`${base}/send`, { headers: { cookie } })).status, 401);
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  child = startAgent({ AGENT_PARENT_PIPE: "1" });
  for (let n = 0; n < 50; n++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, "agent exits when menu app pipe closes");
  child = startAgent({ AGENT_PARENT_PID: "99999999" });
  const watchedExitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(watchedExitCode, 0, "agent exits if its parent process is gone");
  child = startAgent({ HOST_PLATFORM: "windows" });
  let windowsReady = false;
  for (let n = 0; n < 50; n++) {
    try { windowsReady = (await fetch(`${base}/health`)).ok; } catch { /* starting */ }
    if (windowsReady) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(windowsReady, "Windows-mode agent starts");
  const windowsPair = await (await fetch(`${base}/admin/pairing`, { method: "POST" })).json();
  const windowsPairUrl = `${base}${new URL(windowsPair.url).pathname}`;
  const windowsPairPage = await (await fetch(windowsPairUrl)).text();
  assert.match(windowsPairPage, /このPCと接続する/);
  assert.doesNotMatch(windowsPairPage, /このMacと接続する/);
  const windowsPaired = await fetch(windowsPairUrl, { method: "POST" });
  const windowsCookie = windowsPaired.headers.get("set-cookie").split(";")[0];
  const windowsSetup = await (await fetch(`${base}/setup`, { headers: { cookie: windowsCookie } })).text();
  assert.match(windowsSetup, /Windows版：初回ショートカット設定/);
  assert.match(windowsSetup, /「PCに送る」を取得/);
  const windowsShortcut = await fetch(`${base}/install/one-click.shortcut`, { headers: { cookie: windowsCookie } });
  assert.equal(windowsShortcut.status, 200);
  assert.match(decodeURIComponent(windowsShortcut.headers.get("content-disposition")), /PCに送る/);
  assert.deepEqual(
    Buffer.from(await windowsShortcut.arrayBuffer()),
    await fs.readFile(path.join(staticShortcutDirectory, "send-ja.shortcut")),
    "Windows serves the verified pre-signed Japanese template unchanged",
  );
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  console.log("Local agent integration test passed");
} finally {
  child.kill();
  await fs.rm(root, { recursive: true, force: true });
}
