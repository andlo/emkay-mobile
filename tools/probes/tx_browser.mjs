// A dialog transformer in the browser: installed by pip.py, enabled in mycroft.conf,
// used by speech.py (ovos-audio's DialogTransformersService) on "speak".
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
const port = 9338;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-tx",
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
const INTERESTING = /dialog|tts|transformer|Traceback|Error|\(pip\)/i;
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
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  log("booted");
  log(`install: ${await py(`from emkay_mobile import pip\ntry:\n    out = pip.run(['install', '--pre', 'ovos-dialog-normalizer-plugin'])\nexcept RuntimeError as e:\n    out = 'FAILED ' + str(e)\nout[-300:]`)}`);
  log(`enable: ${await py(`from ovos_config.config import update_mycroft_config\nfrom ovos_config import Configuration\nupdate_mycroft_config({"dialog_transformers": {"ovos-dialog-normalizer-plugin": {}}})\nConfiguration.reload()\nfrom emkay_mobile import speech\nspeech.reload()\nd, t = speech.transformers()\nstr([p[0] if isinstance(p, tuple) else getattr(p, 'name', p) for p in d.plugins])`)}`);
  // what a skill's speak() emits
  const said = await js(`new Promise((ok) => {
    const orig = window.emkay.speaker.enqueue.bind(window.emkay.speaker);
    window.emkay.speaker.enqueue = (data, meta) => { ok(meta.utterance); return orig(data, meta); };
    window.emkay.call("python", {code: "from emkay_mobile import boot\\nfrom ovos_bus_client.message import Message\\nboot.bus().emit(Message('speak', {'utterance': \\"I've got 3 apples, it's 2 o'clock\\", 'lang': 'en-US', 'meta': {'skill': 'test.skill'}}, {'skill_id': 'test.skill'}))"});
    setTimeout(() => ok("(nothing spoken in 60 s)"), 60000);
  })`);
  log(`spoken: ${said}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-20)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
