// ovos-stt-plugin-browser in headless Chromium: offered, chosen, used on a tap (issue #2).
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
const port = 9345;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-sttb",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--lang=en-US", "--accept-lang=en-US", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
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
const INTERESTING = /stt|Traceback|Error/i;
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
  // ovos-stt-plugin-browser (issue #2): offered by the control panel like any
  // STT plugin, chosen there, and then a tap uses the browser's recognition.
  // (Chromium without Google's keys cannot actually recognise; on a phone it can.)
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
  const quick = JSON.parse((await api("GET", "/api/config/quick")).replace(/^\d+ /, ""));
  const field = quick.fields.find((f) => f.name === "stt.module");
  log(`panel STT options: ${JSON.stringify(field?.options)} (now ${field?.effective})`);
  log(`installed plugins: ${(await api("GET", "/api/plugins/installed")).slice(0, 4) === "200 " ? "ok" : "?"}`);
  log(`choose it: ${(await api("POST", "/api/config/quick", { values: { "stt.module": "ovos-stt-plugin-browser" } })).slice(0, 40)}`);
  await sleep(3000);
  log(`page STT now: ${await js(`window.emkay.stt()`)} | browser has recognition: ${await js(`!!(self.SpeechRecognition || self.webkitSpeechRecognition)`)}`);
  await js(`window.__captions = []; new MutationObserver(() => { const t = document.getElementById("caption-text").textContent;
    if (window.__captions.at(-1) !== t) window.__captions.push(t); })
    .observe(document.getElementById("caption"), { subtree: true, childList: true, characterData: true }); true`);
  await js(`window.emkay.mic.listen(); true`);
  await until(`!window.emkay.mic.busy`, 30, "the browser's recognition to end");
  log(`captions: ${await js(`JSON.stringify(window.__captions)`)}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-10)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
