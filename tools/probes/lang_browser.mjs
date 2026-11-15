// Emkay's texts and OVOS' default language follow the phone (PHONE_LANG)
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
const port = 9337;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-lang",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run", `--lang=${process.env.PHONE_LANG || "en-US"}`, `--accept-lang=${process.env.PHONE_LANG || "en-US"}`,
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
const INTERESTING = /\(pip\)|rescan|ATTEMPTING TO LOAD|loaded successfully|padaos compile|train|skill\.handler\.start|"speak"|utterance|Traceback|Error|ovos\.pip/i;
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
  await sleep(3000);
  log(`navigator.languages: ${await js(`navigator.languages.join(",")`)}`);
  log(`boot screen: ${await js(`document.getElementById("boot-text").innerText`)} | html lang=${await js(`document.documentElement.lang`)}`);
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  log(`after boot: ${await js(`[document.getElementById("boot-text").innerText, document.getElementById("first").innerText, document.getElementById("start").innerText].join(" | ")`)}`);
  log(`OVOS lang: ${await py("from ovos_config import Configuration; Configuration().get('lang')")}`);
  await js(`document.getElementById("start").click(); true`);
  await sleep(2000);
  log(`menu: ${await js(`[...document.querySelectorAll("#menu button")].map(b => b.innerText).join(" / ")`)}`);
  // the user picks English in the control panel (what its setup page posts)
  await js(`navigator.serviceWorker.ready.then(() => true)`);
  await js(`document.getElementById("menu-panel").click(); true`);
  const w = `document.getElementById("panel-frame").contentWindow`;
  const doc = `document.getElementById("panel-frame").contentDocument`;
  await until(`${doc}?.readyState === "complete" && ${doc}.title`, 120, "panel page");
  const other = process.env.PHONE_LANG?.startsWith("da") ? "en-us" : "da-dk";
  const r = await js(`${w}.fetch("/api/config/quick", {method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({values: {lang: "${other}"}})}).then(r => r.status + " " + r.statusText)`);
  log(`panel sets lang ${other}: ${r}`);
  await sleep(3000);
  log(`now: OVOS lang ${await py("from ovos_config import Configuration; Configuration().get('lang')")} | menu: ${await js(`[...document.querySelectorAll("#menu button")].map(b => b.innerText).join(" / ")`)} | html lang=${await js(`document.documentElement.lang`)}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-15)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
