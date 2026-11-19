// A browser without JavaScript Promise Integration (Safari before 27), in a
// real (headless) Chromium whose JSPI is taken away before any of Emkay's
// code runs – in the page and in every worker (CDP auto-attach, paused at
// start). Emkay must start, hear (no "WebAssembly stack switching not
// supported" from the page's commands), say at the first tap that its ears
// and voice can't run in this browser, download no speech model it can't
// use, send nothing to a speech server until "use OpenVoiceOS' servers in
// this browser" is tapped, and keep that choice for both.
//
//   CHROME=~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome \
//     node tools/probes/nojspi_browser.mjs [url]
//   KEEP_JSPI=1 … runs the same with JSPI, where no such note may show.
import { spawn } from "child_process";
import fs from "fs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const keepJSPI = !!process.env.KEEP_JSPI;
const port = 9351;
const profile = process.env.PROFILE || "/tmp/emkay-chrome-nojspi";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=430,932", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  "--lang=en-US", "--accept-lang=en-US", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

let target;
for (let i = 0; i < 600 && !target; i++) {
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
const send = (method, params = {}, sessionId) => new Promise((r) => {
  const i = ++id; pending.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
// what a browser without JSPI lacks (Pyodide looks for the same)
const DROP = "delete WebAssembly.Suspending; delete WebAssembly.promising; 0";
const workers = [];
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.method === "Target.attachedToTarget") {
    const s = m.params.sessionId;
    workers.push(m.params.targetInfo.url.split("/").pop());
    // a worker's own workers (worker.js starts speech-worker.js) are caught too
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s);
    if (!keepJSPI) await send("Runtime.evaluate", { expression: DROP }, s);
    await send("Runtime.runIfWaitingForDebugger", {}, s);
  }
};
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function until(expression, seconds, what) {
  for (let i = 0; i < seconds * 4; i++) { if (await js(expression)) return; await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
}
const netLog = async () => JSON.parse(await js(`window.emkay.call("net_log").then(JSON.stringify)`) || "[]");
const text = (el) => js(`document.getElementById("${el}").textContent.trim()`);

let failed = false;
const check = (ok, what) => { log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed = true; };

try {
  await send("Page.enable");
  await send("Runtime.enable");
  if (!keepJSPI) await send("Page.addScriptToEvaluateOnNewDocument", { expression: DROP });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  log(`workers: ${workers.join(", ")}`);
  check((await js(`window.emkay.call("python_async", {code: "import js; str(js.emkayJSPI)"})`)) === (keepJSPI ? "True" : "False"),
    keepJSPI ? "OVOS' worker has JSPI" : "OVOS' worker has no JSPI");
  await js(`document.getElementById("start").click(); true`);
  const t1 = Date.now();
  await sleep(1500);

  const noteShown = await js(`!document.getElementById("speech-wait").hidden`);
  const note = await text("speech-wait-text"), button = await text("speech-wait-servers");
  if (keepJSPI) {
    check(!/this browser/i.test(noteShown ? note : ""), "no 'this browser can't' note where there is JSPI");
  } else {
    check(noteShown && /this browser can't run/i.test(note), `the note at the first tap: “${note}”`);
    check(/in this browser/i.test(button), `its button: “${button}”`);
  }

  // what the page's microphone does after the wake word: begin, then hand over
  // what it heard (silence) – these failed with "stack switching" before
  const begin = await js(`window.emkay.call("record_begin").then(() => "ok", (e) => "ERR " + (e.message || e))`);
  check(begin === "ok", `record_begin: ${begin} (${((Date.now() - t1) / 1000).toFixed(1)} s after the tap)`);
  const heard = await js(`window.emkay.call("heard", {pcm: new Uint8Array(32000).buffer, rate: 16000})
    .then(() => "ok", (e) => "ERR " + (e.message || e))`);
  check(!/stack switching/i.test(heard), `heard: ${heard}`);

  // a typed question is answered (as text where Emkay can't speak)
  await js(`window.emkay.call("heard_text", {text: "what is two plus two"}); true`);
  await sleep(8000);
  log(`caption: “${await text("caption-text")}”`);

  const before = await netLog();
  const models = before.filter((e) => /huggingface|hf\.co/.test(e.host || ""));
  const speech = before.filter((e) => e.kind === "stt" || e.kind === "tts");
  if (!keepJSPI) {
    check(models.length === 0, `no speech model downloaded (${models.map((e) => e.host).join(", ") || "none"})`);
    check(speech.length === 0, `nothing sent to a speech server before the tap (${speech.length})`);

    await js(`document.getElementById("speech-wait-servers").click(); true`);
    await sleep(1500);
    const user = JSON.parse(await js(`window.emkay.call("python_async", {code:
      "import json; from emkay_mobile import boot; c = boot.read_user_config(); json.dumps({k: (c.get(k) or {}).get('fallback_module') for k in ('stt', 'tts')})"})`));
    log(`user config after the tap: ${JSON.stringify(user)}`);
    check(user.stt === "ovos-stt-plugin-server" && user.tts === "ovos-tts-plugin-server",
      "the servers are kept for both ears and voice (next start)");
    await js(`window.emkay.call("say", {text: "hello there"}); true`);
    await sleep(8000);
    const after = (await netLog()).filter((e) => e.kind === "tts");
    check(after.length > 0, `the servers speak after the tap (${after.map((e) => e.host).join(", ")})`);
  }
} catch (e) {
  check(false, e.message);
} finally {
  chrome.kill();
  log(failed ? "FAILED" : "PASSED");
  process.exit(failed ? 1 : 0);
}
