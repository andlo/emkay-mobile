// Whisper STT on the phone (ovos-stt-plugin-whisper-browser, web/whisper.js)
// in headless Chromium (#23, offline).
//
// Chooses Whisper as the STT, sends a recording of "what time is it" through
// Emkay's own path for recorded speech twice: the first time the model is
// still downloading, so stt.fallback_module answers; once the model is
// loaded, Whisper does. Then a Danish round trip that never leaves the
// phone: Piper says "hvad er klokken" and Whisper hears it back.
// Prints "whisper ok" on success.
//
//   CHROME=... node tools/probes/whisper_browser.mjs [url]
//   WHISPER_MODEL=onnx-community/whisper-tiny   (default: the plugin's)
//   DANISH=0                                     skip the Danish round trip
import { spawn } from "child_process";
import { readFileSync } from "fs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const port = 9371;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-whisper",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  "--enable-unsafe-swiftshader", "--lang=en-US", "--accept-lang=en-US", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const workerLog = [];

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
  if (m.method === "Runtime.consoleAPICalled") {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    workerLog.push(text);
    if (/whisper|\] stt|Traceback|Error/i.test(text)) log(`  console: ${text.slice(0, 300)}`);
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

// a WAV's 16-bit samples and rate (fmt and data chunks)
function pcmOf(wav) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let off = 12, rate = 16000, data = null;
  while (off + 8 <= wav.length) {
    const tag = String.fromCharCode(...wav.slice(off, off + 4)), size = view.getUint32(off + 4, true);
    if (tag === "fmt ") rate = view.getUint32(off + 12, true);
    if (tag === "data") { data = wav.slice(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  return { pcm: Array.from(data), rate };
}
/** Emkay's path for a recording (worker_main.heard); the text it heard. */
async function heard({ pcm, rate }) {
  return js(`(async () => {
    const pcm = new Uint8Array(${JSON.stringify(pcm)});
    return String(await window.emkay.call("heard", { pcm: pcm.buffer, rate: ${rate} }, [pcm.buffer]));
  })()`);
}

try {
  await send("Runtime.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  await sleep(8000);
  const model = process.env.WHISPER_MODEL;
  log(`choose: ${await js(`window.emkay.call("python", {code: ${JSON.stringify(`from emkay_mobile import boot, speech
from ovos_config import Configuration
boot.write_user_config({"stt": {"module": "ovos-stt-plugin-whisper-browser", "fallback_module": "ovos-stt-plugin-server",
                                "ovos-stt-plugin-whisper-browser": ${model ? `{"model": "${model}"}` : "{}"}}})
Configuration.reload()
speech.reload()
"whisper chosen"`)}}).then(String)`)}`);

  const english = pcmOf(readFileSync(new URL("./audio/what_time.wav", import.meta.url)));
  log(`first (model downloading, the fallback answers): "${await heard(english)}"`);
  const t = Date.now();
  for (let i = 0; i < 600 && !workerLog.some((l) => /whisper .* ready on/.test(l)); i++) await sleep(1000);
  if (!workerLog.some((l) => /whisper .* ready on/.test(l))) throw new Error("the Whisper model did not load in 10 minutes");
  log(`model loaded in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  // what Piper says on the phone, Whisper hears on the phone
  const sayAndHear = (voice, sentence, lang) => js(`window.emkay.call("python_async", {code: ${JSON.stringify(`import asyncio, io, js, wave
from pyodide.ffi import run_sync
from emkay_mobile import speech
voice = "VOICE"
for _ in range(600):
    if run_sync(js.emkayPiper.ready(voice)):
        break
    await asyncio.sleep(1)
data = bytes(run_sync(js.emkayPiper.synth("SENTENCE", voice, 0)).to_py())
with wave.open(io.BytesIO(data)) as w:
    pcm, rate = w.readframes(w.getnframes()), w.getframerate()
speech.transcribe(pcm, rate, "LANG")`)}.replace("VOICE", ${JSON.stringify(voice)}).replace("SENTENCE", ${JSON.stringify(sentence)}).replace("LANG", ${JSON.stringify(lang)})}).then(String)`);
  const checks = [
    ["en_US-lessac-medium", "What time is it?", "en-US", /time/i],
    ["en_US-lessac-medium", "Set a timer for five minutes.", "en-US", /timer/i],
    ...(process.env.DANISH === "0" ? [] : [
      ["da_DK-talesyntese-medium", "Hvad er klokken?", "da-DK", /klokken/i],
      ["da_DK-talesyntese-medium", "Sæt en timer på fem minutter.", "da-DK", /timer/i],
    ]),
  ];
  let failed = 0;
  for (const [voice, sentence, lang, want] of checks) {
    const got = await sayAndHear(voice, sentence, lang);
    const ok = want.test(got);
    if (!ok) failed++;
    log(`${ok ? "heard" : "MISHEARD"} (${lang}) "${sentence}" -> "${got}"`);
  }
  if (!workerLog.some((l) => /\[emkay\] whisper [\d.]+s for/.test(l))) throw new Error("Whisper did not transcribe");
  if (failed) throw new Error(`${failed} of ${checks.length} misheard`);
  log("whisper ok");
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  ws.close();
  chrome.kill();
}
