// Music in headless Chromium (#16): ovos-audio's AudioService plays a track
// through ovos-audio-plugin-browser in the page's <audio> element.
//
// Boots Emkay, taps start, puts mycroft.audio.service.play on the bus with
// a short tone (a data: URI, so the test needs no radio station), and
// checks that the page plays it, that speech ducks it, and that the
// service hears the end. Prints "media ok" on success. Optional:
//   STREAM=https://...   play this instead (a real station), then stop it
//
//   CHROME=... node tools/probes/media_browser.mjs [url]
import { spawn } from "child_process";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const port = 9361;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-media",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  "--enable-unsafe-swiftshader", "about:blank"], { stdio: "ignore" });
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
  if (m.method === "Runtime.consoleAPICalled") {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (/audio|media|ocp|error|exception/i.test(text)) log(`  console: ${text.slice(0, Number(process.env.LOGLEN || 300))}`);
  }
  if (m.method === "Runtime.exceptionThrown") log(`  EXCEPTION: ${m.params.exceptionDetails.exception?.description?.slice(0, 300)}`);
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
const emit = (type, data = {}) =>
  js(`window.emkay.call("core_send", {raw: JSON.stringify(${JSON.stringify({ type, data, context: {} })})}); true`);

// 3 s of a quiet 440 Hz tone as a WAV data: URI
function toneUri(seconds = 3, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(2000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return "data:audio/wav;base64," + buf.toString("base64");
}

try {
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  await sleep(8000);
  // the bus as the page sees it (every message, for the visage's core socket)
  await js(`window.__bus = []; window.emkayVisage2.subscribe("core", (raw) => {
    try { const m = JSON.parse(raw); if (/^(ovos\\.audio\\.|mycroft\\.audio\\.)/.test(m.type)) window.__bus.push(m.type); } catch {} }); true`);
  const uri = process.env.STREAM || toneUri();
  log(`play ${uri.slice(0, 60)}`);
  await emit("mycroft.audio.service.play", { tracks: [uri] });
  await until(`window.emkay.media.state().uri && !window.emkay.media.state().paused`, 30, "the page to play");
  log(`playing: ${JSON.stringify(await js(`window.emkay.media.state()`)).slice(0, 200)}`);
  const full = await js(`window.emkay.media.state().volume`);
  await emit("ovos.audio.output.started");
  await until(`window.emkay.media.state().volume < ${full}`, 10, "ducking while OVOS speaks");
  await emit("ovos.audio.output.ended");
  await until(`window.emkay.media.state().volume === ${full}`, 10, "the volume back after speech");
  log("ducked and restored");
  if (process.env.STREAM) {
    await sleep(4000);
    await emit("mycroft.audio.service.stop");
    await until(`!window.emkay.media.state().uri`, 10, "stop");
  } else {
    await until(`window.__bus.includes("mycroft.audio.queue_end")`, 20, "the end of the track to reach AudioService");
  }
  log(`bus: ${(await js(`window.__bus.join(" ")`)).slice(0, 400)}`);
  log("media ok");
} catch (e) {
  log(`FAILED: ${e.message}`);
  log(`bus: ${(await js(`(window.__bus || []).join(" ")`) || "").slice(0, 400)}`);
} finally {
  ws.close();
  chrome.kill();
}
