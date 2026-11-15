// The new visage (?visage=new, issue #22) in headless Chromium: boot, tap
// start, ask something, and take screenshots; prints the page's (and the
// visage frame's) console lines and errors.
//
//   CHROME=... node tools/probes/visage2_browser.mjs [url] [out-prefix]
//   QUESTIONS="what time is it|tell me a joke"   (typed, one after another)
import { spawn } from "child_process";
import { writeFileSync } from "fs";

const base = process.argv[2] || "http://127.0.0.1:8080/";
const out = process.argv[3] || "/tmp/visage2";
const url = base + (base.includes("?") ? "&" : "?") + "visage=new";
const port = 9351;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-v2",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream", "--no-first-run", "--enable-unsafe-swiftshader", "about:blank"], { stdio: "ignore" });
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
const GREP = new RegExp(process.env.GREP || "visage|gui|socket|flutter|error|fail|core|exception", "i");
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && !m.sessionId) {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (GREP.test(text)) log(`  console: ${text.slice(0, 300)}`);
  }
  if (m.method === "Runtime.exceptionThrown") log(`  EXCEPTION: ${m.params.exceptionDetails.exception?.description?.slice(0, 300)}`);
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") log(`  log: ${m.params.entry.text.slice(0, 300)} ${m.params.entry.url || ""}`);
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
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}-${name}.png`, Buffer.from(r.result.data, "base64"));
  log(`screenshot ${out}-${name}.png`);
}
try {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  log("booted; tapping start");
  await js(`document.getElementById("start").click(); true`);
  await sleep(Number(process.env.SETTLE_MS || 25000));
  log(`frame: ${await js(`(() => { const f = document.getElementById("visage2"); return f ? f.contentDocument?.readyState + " " + !!f.contentWindow.WebSocket : "none"; })()`)}`);
  await shot("idle");
  for (const q of (process.env.QUESTIONS || "what time is it").split("|")) {
    log(`say: ${q}`);
    await js(`window.emkay.call("say", {text: ${JSON.stringify(q)}}); true`);
    await sleep(2500);
    await shot(q.replace(/\W+/g, "_") + "-a");
    await sleep(Number(process.env.ANSWER_MS || 7000));
    await shot(q.replace(/\W+/g, "_") + "-b");
  }
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  ws.close();
  chrome.kill();
}
