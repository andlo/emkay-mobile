// Which STT servers a language's speech goes to, and how long each takes.
// Runs speech.transcribe on SPEECH_WAV for STT_LANG in the worker, with every
// HTTP request it makes printed (url, status, seconds). For "STT hangs in
// Danish" kind of questions.
//
//   CHROME=... SPEECH_WAV=tools/probes/audio/what_time.wav STT_LANG=da-DK \
//     node tools/probes/stt_lang_browser.mjs [url]
import { spawn } from "child_process";
import { readFileSync } from "fs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const lang = process.env.STT_LANG || "da-DK";
const port = 9343;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-sttlang",
  "--window-size=390,844", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable", sessionId: m.params.sessionId }));
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.runIfWaitingForDebugger", sessionId: m.params.sessionId }));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.sessionId) {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (/\[http\]|\[emkay\] stt|Traceback|Error/.test(text)) log(text.slice(0, 260));
  }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function until(expression, seconds, what) {
  for (let i = 0; i < seconds * 2; i++) { if (await js(expression)) return; await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
}

// the wav's PCM (skip the 44-byte header), as base64 for the Python side
const pcm = readFileSync(process.env.SPEECH_WAV).subarray(44).toString("base64");
try {
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  log(`ready; transcribing in ${lang}`);
  const code = `import base64, time, requests
_orig = requests.Session.request
def _req(self, method, url, *a, **kw):
    t = time.time()
    try:
        r = _orig(self, method, url, *a, **kw)
        print(f"[http] {method} {url[:120]} -> {r.status_code} in {time.time()-t:.1f}s (timeout {kw.get('timeout')})")
        return r
    except Exception as e:
        print(f"[http] {method} {url[:120]} -> {type(e).__name__}: {str(e)[:80]} in {time.time()-t:.1f}s (timeout {kw.get('timeout')})")
        raise
requests.Session.request = _req
from emkay_mobile import speech
t = time.time()
try:
    out = repr(speech.transcribe(base64.b64decode("${pcm}"), 16000, "${lang}"))
except Exception as e:
    out = f"{type(e).__name__}: {e}"
requests.Session.request = _orig
f"{out} after {time.time()-t:.1f}s"`;
  const t = Date.now();
  const r = await Promise.race([
    js(`window.emkay.call("python", {code: ${JSON.stringify(code)}})`),
    sleep(Number(process.env.WAIT_MS || 240000)).then(() => "STILL WAITING"),
  ]);
  log(`result: ${r} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  ws.close();
  chrome.kill();
}
