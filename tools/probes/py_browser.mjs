// Boot Emkay in headless Chromium and print the value of Python expressions
// run in the worker, for looking at OVOS' state in the browser itself.
//
//   CHROME=... PY='from ovos_config import Configuration; str(Configuration()["intents"]["pipeline"])' \
//     node tools/probes/py_browser.mjs [url]
// PY may hold several expressions separated by "\n---\n"; each is one call.
import { spawn } from "child_process";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const port = 9344;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-py",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run", `--lang=${process.env.PHONE_LANG || "en-US"}`, "about:blank"], { stdio: "ignore" });
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
  if (m.method === "Runtime.consoleAPICalled" && m.sessionId && process.env.GREP) {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (new RegExp(process.env.GREP, "i").test(text)) log(`  ${text.slice(0, 300)}`);
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
try {
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  if (process.env.START) await js(`document.getElementById("start").click(); true`);
  if (process.env.SLEEP_MS) await sleep(Number(process.env.SLEEP_MS));
  if (process.env.JS) {   // JS=expression: evaluated in the page (awaited), e.g. window.emkay.call("sync")
    const t = Date.now();
    log(`JS: ${await Promise.race([js(process.env.JS).then(String), sleep(Number(process.env.JS_MS || 30000)).then(() => "STILL WAITING")])} (${Date.now() - t} ms)`);
  }
  if (process.env.SHOT) {   // SHOT=file.png: a screenshot of the page
    const { writeFileSync } = await import("fs");
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.SHOT, Buffer.from(r.result.data, "base64"));
    log(`screenshot: ${process.env.SHOT}`);
  }
  for (const code of (process.env.PY || "1").split("\n---\n")) {
    log(`>>> ${code.split("\n").at(-1).slice(0, 100)}`);
    const cmd = process.env.ASYNC ? "python_async" : "python";
    if (process.env.ALSO) {   // ALSO=code: run alongside (does the worker answer while the first waits?)
      const t = Date.now();
      const first = js(`window.emkay.call("${cmd}", {code: ${JSON.stringify(code)}}).then(String)`);
      await sleep(300);
      log(`alongside: ${await js(`window.emkay.call("python", {code: ${JSON.stringify(process.env.ALSO)}}).then(String)`)} after ${Date.now() - t} ms`);
      log(`first: ${await first} after ${Date.now() - t} ms`);
      continue;
    }
    log(String(await js(`window.emkay.call("${cmd}", {code: ${JSON.stringify(code)}})`)));
  }
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  ws.close();
  chrome.kill();
}
