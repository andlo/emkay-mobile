// Never silence (issue #6): a question nothing answers gets OVOS' error sound and a line.
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
const port = 9346;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-na",
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
const INTERESTING = /match \(|fallback|speak|Traceback|Error/i;
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
  // never silence (issue #6): a typed question nothing answers gets OVOS'
  // error sound and a line; one that is answered does not
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  await js(`window.__captions = []; window.__sounds = 0; window.__said = [];
    new MutationObserver(() => { const t = document.getElementById("caption-text").textContent;
      if (window.__captions.at(-1) !== t) window.__captions.push(t); })
      .observe(document.getElementById("caption"), { subtree: true, childList: true, characterData: true });
    const s = window.emkay.speaker.playSound.bind(window.emkay.speaker);
    window.emkay.speaker.playSound = (d) => { window.__sounds++; return s(d); };
    const q = window.emkay.speaker.enqueue.bind(window.emkay.speaker);
    window.emkay.speaker.enqueue = (d, m) => { window.__said.push(m.utterance); return q(d, m); }; true`);
  // the warm-up first (padaos), so the questions are timed alone
  await sleep(45000);
  const ask = async (text) => {
    await js(`window.__captions = []; window.__sounds = 0; window.__said = [];
      document.getElementById("type-text").value = ${JSON.stringify(text)};
      document.getElementById("type").requestSubmit(); true`);
    await sleep(20000);
    log(`"${text}": said ${await js(`JSON.stringify(window.__said)`)} | captions ${await js(`JSON.stringify(window.__captions)`)} | sounds ${await js(`window.__sounds`)}`);
  };
  await ask("what time is it");
  for (const q of ["search duckduckgo for the history of copenhagen", "ask wolfram alpha what is the mass of the moon", "who is the president of mongolia"]) await ask(q);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-30)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
