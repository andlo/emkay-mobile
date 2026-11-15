// The control panel's Backup page in headless Chromium: download, change, restore.
// real (headless) Chromium: panel API -> ovos-core's installer -> pip.py.
// Also collects the worker's own console (OVOS' log) with timestamps.
//
//   CHROME=~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
//     node tools/probes/install_browser.mjs [url] [package] [utterance]
//
// Uses a throw-away profile in /tmp and talks to Chromium over CDP.
import { spawn } from "child_process";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const pkg = process.argv[3] || "ovos-skill-randomness";
const ask = process.argv[4] || "flip a coin";
const port = 9341;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-backup",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run", 
  "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const log = (m) => console.log(`${stamp()} ${m}`);

let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
      .find((t) => t.type === "page" && t.url.startsWith("about:blank"));
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const workerLines = [];
const INTERESTING = /backup|restore|Traceback|Error/i;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable", sessionId: m.params.sessionId }));
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.runIfWaitingForDebugger", sessionId: m.params.sessionId }));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.sessionId) {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (INTERESTING.test(text)) workerLines.push(`${stamp()} ${text.slice(0, 220)}`);
  }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function until(expression, seconds, what) {
  for (let i = 0; i < seconds * 2; i++) {
    const v = await js(expression);
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const py = (code) => js(`window.emkay.call("python", {code: ${JSON.stringify(code)}})`);

try {
  // the control panel's Backup page: download a backup, change a setting,
  // restore the backup, and the setting is back
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  await js(`navigator.serviceWorker.ready.then(() => true)`);
  await js(`document.getElementById("menu-panel").click(); true`);
  const w = `document.getElementById("panel-frame").contentWindow`;
  const doc = `document.getElementById("panel-frame").contentDocument`;
  await until(`${doc}?.readyState === "complete" && ${doc}.title`, 120, "panel page");
  const api = (method, path, body) => js(`${w}.fetch("${path}", {method: "${method}", headers: {"content-type": "application/json"}${body ? `, body: JSON.stringify(${JSON.stringify(body)})` : ""}}).then(async r => r.status + " " + (await r.text()))`);
  const unit = () => py("from ovos_config import Configuration; Configuration().get('system_unit')");
  log(`set token: ${await api("POST", "/api/auth/token", { new: "emkay-test-token" })}`);
  log(`set unit imperial: ${(await api("POST", "/api/config/quick", { values: { system_unit: "imperial" } })).slice(0, 60)} -> ${await unit()}`);
  // the backup, as the page's "Download a backup" fetches it
  log(`backup: ${await js(`${w}.fetch("/api/backup").then(async r => { window.__backup = await r.blob();
    return r.status + " " + r.headers.get("content-type") + " " + r.headers.get("content-disposition") + " " + window.__backup.size + " bytes"; })`)}`);
  log(`set unit metric: ${(await api("POST", "/api/config/quick", { values: { system_unit: "metric" } })).slice(0, 60)} -> ${await unit()}`);
  // the restore, as the page's form posts it
  log(`restore: ${await js(`(() => { const W = ${w}; const f = new W.FormData(); f.append("file", window.__backup, "backup.tar.gz");
    return W.fetch("/api/restore", {method: "POST", body: f}).then(async r => r.status + " " + (await r.text())); })()`)}`);
  await sleep(2000);
  log(`after restore: unit ${await unit()}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-15)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
