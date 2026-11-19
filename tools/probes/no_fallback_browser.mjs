// No silent server fallback (defaults v15) in a real (headless) Chromium,
// with a fresh profile, so the voice is still downloading: a question
// answered right after start is shown as text, the "waiting" note offers
// OpenVoiceOS' servers, nothing goes to them before that is tapped, and the
// privacy chip stays on the device; after the tap the servers speak and
// the chip turns amber.
//
//   CHROME=~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
//     node tools/probes/no_fallback_browser.mjs [url] [screenshot-prefix]
import { spawn } from "child_process";
import fs from "fs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const prefix = process.argv[3] || "";
const port = 9349;
const profile = process.env.PROFILE || "/tmp/emkay-chrome-nofallback";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=430,932", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  `--lang=${process.env.PHONE_LANG || "en-US"}`, `--accept-lang=${process.env.PHONE_LANG || "en-US"}`, "about:blank"], { stdio: "ignore" });
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function until(expression, seconds, what) {
  for (let i = 0; i < seconds * 4; i++) { if (await js(expression)) return; await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
}
async function shot(name) {
  if (!prefix) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${prefix}${name}.png`, Buffer.from(r.result.data, "base64"));
  log(`screenshot ${prefix}${name}.png`);
}
const chip = () => js(`document.getElementById("privacy-chip").className + " | " + document.getElementById("privacy-chip").textContent.trim()`);
// requests to the speech servers (netlog.js' kinds "stt" and "tts"), as "host kind"
const speechRequests = () => js(`window.emkay.call("net_log").then((l) => JSON.stringify(l
  .filter((e) => e.kind === "stt" || e.kind === "tts")
  .map((e) => e.host + " " + e.kind + " " + e.method + " by " + e.who + " at " + new Date(e.t).toISOString().slice(11, 19))))`);
const toServers = async () => {
  const r = JSON.parse(await speechRequests() || "[]");
  if (r.length) log(`speech server requests: ${r.join(", ")}`);
  return r.length;
};
const voiceReady = () => js(`!document.getElementById("model-status").hidden && /voice/i.test(document.getElementById("model-status-text").textContent)`);

let failed = false;
const check = (ok, what) => { log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed = true; };

try {
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  log(`config: ${await js(`window.emkay.call("activity_setup").then(JSON.stringify)`)}`);
  check(!/"tts_fallback":"ovos-tts-plugin-server"|"stt_fallback":"ovos-stt-plugin-server"/.test(
    await js(`window.emkay.call("activity_setup").then(JSON.stringify)`)), "no server fallback in the config");

  log(`speech server requests at start: ${await toServers()} (now ${new Date().toISOString().slice(11, 19)})`);
  // right away, while the voice is still downloading
  await js(`window.emkay.call("say", {text: "what time is it"}); true`);
  await until(`!document.getElementById("speech-wait").hidden`, 120, "the waiting note");
  log(`note: ${await js(`document.getElementById("speech-wait").innerText.replace(/\\n+/g, " | ")`)}`);
  log(`caption: ${await js(`document.getElementById("caption-text").textContent`)}`);
  check(/“.+”/.test(await js(`document.getElementById("caption-text").textContent`)), "the answer is shown as text");
  check(/privacy-chip device/.test(await chip()), `chip stays on the device (${await chip()})`);
  await shot("1-waiting");
  await sleep(4000);
  check(await toServers() === 0, "nothing sent to the speech servers");

  // the user chooses the servers for now
  await js(`document.getElementById("speech-wait-servers").click(); true`);
  await sleep(500);
  log(`caption: ${await js(`document.getElementById("caption-text").textContent`)}`);
  check(await js(`document.getElementById("speech-wait").hidden`), "the note closes");
  await js(`window.emkay.call("say", {text: "what day is it"}); true`);
  let amber = false;
  for (let i = 0; i < 240 && !amber; i++) { amber = /external/.test(await chip()); if (!amber) await sleep(250); }
  log(`chip: ${await chip()}`);
  check(amber, "after the tap the servers stand in, and the chip turns amber");
  await shot("2-servers");
  log(`to the speech servers now: ${await toServers()}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
  failed = true;
} finally {
  ws.close();
  chrome.kill();
  process.exit(failed ? 1 : 0);
}
