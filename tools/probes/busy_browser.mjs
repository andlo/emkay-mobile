// What keeps the worker busy after Emkay says it is ready (issue #4).
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
const port = 9343;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-busy",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--lang=en-US", "--accept-lang=en-US",
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
const INTERESTING = /./;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable", sessionId: m.params.sessionId }));
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.runIfWaitingForDebugger", sessionId: m.params.sessionId }));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.sessionId) {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (text.startsWith("[stack]")) console.log(`${stamp()} ${text.slice(0, 1500)}`);
    else if (INTERESTING.test(text)) workerLines.push(`${stamp()} ${text.slice(0, 220)}`);
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
  // what keeps the worker busy after "ready": ping it every second and log
  // how long each answer takes, next to everything the worker logs
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  log("ready (start button shown)");
  await js(`document.getElementById("start").click(); true`);
  // QUESTION: also ask something typed, and see what follows the answer
  if (process.env.QUESTION) {
    await sleep(5000);
    // where Python is, every 5 s, even while the worker is busy (STACKS=1)
    if (process.env.STACKS)
    await py(`import sys, time, traceback
_t = [time.time()]
def _prof(frame, event, arg):
    if time.time() - _t[0] > 5:
        _t[0] = time.time()
        print("[stack] " + " <- ".join(f"{fs.name}@{fs.filename.split('/')[-1]}:{fs.lineno}" for fs in reversed(traceback.extract_stack(frame)[-14:])))
sys.setprofile(_prof)
"ok"`);
    log(`asking: ${process.env.QUESTION}`);
    await js(`window.emkay.call("say", {text: ${JSON.stringify(process.env.QUESTION || "")}}); true`);
  }
  const until60 = Date.now() + Number(process.env.WATCH_MS || 90000);
  while (Date.now() < until60) {
    const t = Date.now();
    await js(`window.emkay.call("python", {code: "1"})`);
    const ms = Date.now() - t;
    if (ms > 300) log(`worker answered a ping after ${ms} ms`);
    await sleep(1000);
  }
  log(`m2v model loaded: ${await py("from emkay_mobile import boot; str({k: getattr(v, 'model', 'n/a') is not None for k, v in boot._manager.intents.pipeline_plugins.items() if hasattr(v, '_ensure_model')})")}`);
  log(`deferred: ${await py("from emkay_mobile import browser; str(browser.STARTED[-25:])")}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
