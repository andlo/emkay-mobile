// Emkay with its OWN OVOS, connected to Home Assistant (ha-device.js), in
// headless Chromium – with LINK=1. Otherwise: the Home Assistant brain (#29): log in to HA the way
// Emkay does (HA's login flow with Emkay's address as client_id – the code
// is fetched here instead of typed on HA's page, then handed to Emkay as HA
// would, ?code=…&state=…), tap start, ask by typing (or speak with
// SPEECH_WAV), and see HA's Assist answer and Emkay speak it.
//
//   HA_URL=http://127.0.0.1:8123 HA_USER=… HA_PASSWORD=… CHROME=… \
//     node tools/probes/homeassistant_browser.mjs [url] [screenshot.png]
//
// SPEECH_WAV=tools/probes/audio/hey_mycroft_what_time.wav: the microphone is
// that file, the wake word is "hey mycroft", and the recording goes to the
// pipeline's speech-to-text.
import { spawn } from "child_process";
import { writeFileSync } from "fs";

const base = process.argv[2] || "http://127.0.0.1:8080/";
const shot = process.argv[3] || "/tmp/ha-face.png";
const ha = process.env.HA_URL || "http://127.0.0.1:8123";
const origin = new URL(base).origin;
const post = async (path, body) => (await fetch(ha + path, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
let flow = await post("/auth/login_flow", { client_id: `${origin}/`, handler: ["homeassistant", null], redirect_uri: base });
flow = await post(`/auth/login_flow/${flow.flow_id}`, { client_id: `${origin}/`,
  username: process.env.HA_USER, password: process.env.HA_PASSWORD });
if (!flow.result) throw new Error(`HA login: ${JSON.stringify(flow.errors)}`);
const LINK = process.env.LINK === "1";
const state = LINK ? "emkay-ha-link.probe" : "emkay-ha.probe";
const url = `${base}?code=${flow.result}&state=${state}`;
const port = 9399;
const chrome = spawn(process.env.CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  "--user-data-dir=/tmp/emkay-chrome-ha", "--window-size=390,844", "--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run",
  "--enable-unsafe-swiftshader",
  ...(process.env.SPEECH_WAV ? [`--use-file-for-fake-audio-capture=${process.env.SPEECH_WAV}`] : []), "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) return pending.get(m.id)?.(m.result);
  if (m.method === "Runtime.exceptionThrown") log(`EXCEPTION ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  if (m.method === "Runtime.consoleAPICalled") {
    const line = m.params.args.map((a) => a.value ?? a.description).join(" ");
    if (/^\[(emkay|piper)\]/.test(line)) log(`console ${line.slice(0, 160)}`);
  }
};
const js = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
async function until(expr, seconds, what) {
  for (let i = 0; i < seconds * 2; i++) { if (await js(expr)) return; await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
}
async function tap(id) {
  const box = await js(`(() => { const r = document.getElementById("${id}").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", clickCount: 1 });
  }
}

try {
  await send("Runtime.enable");
  // what Emkay keeps before it sends you to HA's login page
  await send("Page.navigate", { url: `${base}manifest.webmanifest` });
  await sleep(500);
  await js(`localStorage.clear(); localStorage.setItem("emkay-brain", ${JSON.stringify(LINK ? "local" : "homeassistant")});
    localStorage.setItem("emkay-ha", JSON.stringify({ url: ${JSON.stringify(ha)}, name: "Emkay probe", link: ${LINK}, device_id: ${JSON.stringify(process.env.DEVICE_ID || "emkay-probe-device")}${process.env.SPEECH_WAV ? ', wakeWord: "hey_mycroft"' : ""} }));
    sessionStorage.setItem("emkay-ha-login", "${state}"); true`);
  await send("Page.navigate", { url });
  // boot is done when the visage's frame is on the page (app.js showVisage)
  await until(`!!document.getElementById("visage2") && !document.getElementById("start").hidden`, LINK ? 300 : 60, "the start button");
  log(`boot: ${await js(`document.getElementById("boot-text").textContent`)}`);
  log(`code gone: ${await js(`!location.search`)}, refresh token kept: ${await js(`!!JSON.parse(localStorage.getItem("emkay-ha")).refresh`)}`);
  log(`menu: panel ${await js(`!document.getElementById("menu-panel").hidden`)}, store ${await js(`!document.getElementById("menu-store").hidden`)}, network ${await js(`!document.getElementById("menu-network").hidden`)}`);
  await tap("start");
  await until(`document.getElementById("boot").hidden`, 10, "the boot screen to go");
  log(`started; wake word: ${await js(`window.emkay.wake.state`)}`);
  // the mouth: enclosure.mouth.viseme_list on the visage's bus while speaking
  await js(`window.__mouth = []; window.emkayVisage2.subscribe("core", (raw) => { try { const m = JSON.parse(raw);
    if (m.type === "enclosure.mouth.viseme_list") window.__mouth.push(m.data.visemes.length); } catch {} }); true`);
  await js(`window.__captions = []; window.__said = [];
    new MutationObserver(() => { const t = document.getElementById("caption-text").textContent;
      if (window.__captions.at(-1) !== t) window.__captions.push(t); })
      .observe(document.getElementById("caption"), { subtree: true, childList: true, characterData: true });
    const orig = window.emkay.speaker.enqueue.bind(window.emkay.speaker);
    window.emkay.speaker.enqueue = (data, meta) => { window.__said.push(meta.utterance); return orig(data, meta); }; true`);
  if (process.env.SPEECH_WAV) {
    await until(`document.getElementById("mic").classList.contains("wake")`, 60, "the wake word engine");
    log(`wake word engine: ${await js("window.emkay.wake.engineName")}; listening for "hey mycroft"`);
  } else {
    await sleep(1500);
    await js(`(() => { const f = document.getElementById("type"); f.hidden = false;
      document.getElementById("type-text").value = ${JSON.stringify(process.env.QUESTION || "what time is it")};
      f.requestSubmit(); })()`);
    log("asked");
  }
  await until(`window.emkay.speaker.spoken > 0`, 240, "an answer to be spoken");
  log(`said: ${await js(`JSON.stringify(window.__said)`)}`);
  log(`captions: ${await js(`JSON.stringify(window.__captions)`)}`);
  await until(`!window.emkay.speaker.playing`, 30, "the answer to finish");
  log("played");
  log(`mouth: ${await js(`JSON.stringify(window.__mouth)`)} visemes per answer`);
  await until(`window.emkay.wake.state !== "loading"`, 30, "the wake word engine");
  log(`wake word: ${await js(`window.emkay.wake.engineName`)} ${await js(`document.getElementById("mic").classList.contains("wake") ? "listening" : window.emkay.wake.state`)}`);
  await sleep(1500);
  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(shot, Buffer.from(png.data, "base64"));
  log(`screenshot: ${shot}`);
  // HOLD=<seconds>: stay connected, for trying HA's side (the device's
  // entities) by hand; shows what HA changes on the page
  for (let i = 0, last = ""; i < +(process.env.HOLD || 0); i += 2) {
    const now = await js(`JSON.stringify({ level: window.emkay.speaker.level, wake: window.emkay.wake.engineName,
      mic: document.getElementById("mic").className, said: window.__said })`);
    if (now !== last) log(`page: ${(last = now)}`);
    await sleep(2000);
  }
} catch (e) {
  log(`FAILED: ${e.message}`);
  log(`captions so far: ${await js(`JSON.stringify(window.__captions || [])`)}`);
  const png = await send("Page.captureScreenshot", { format: "png" });
  if (png?.data) writeFileSync(shot, Buffer.from(png.data, "base64"));
}
chrome.kill();
process.exit(0);
