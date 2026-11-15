// Install, use and remove a skill through the stock control panel, in a
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
const port = 9335;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-install",
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
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  await js(`navigator.serviceWorker.ready.then(() => true)`);
  await js(`document.getElementById("menu-panel").click(); true`);
  const doc = `document.getElementById("panel-frame").contentDocument`;
  await until(`${doc}?.readyState === "complete" && ${doc}.title`, 120, "panel page");
  log("panel open");
  await sleep(60000);   // let padatious' first deferred compile finish
  const w = `document.getElementById("panel-frame").contentWindow`;
  const api = async (method, path, body) => {
    const t = Date.now();
    const r = await js(`${w}.fetch("${path}", {method: "${method}",
      headers: {"content-type": "application/json"}${body ? `, body: JSON.stringify(${JSON.stringify(body)})` : ""}})
      .then(async (r) => ({status: r.status, body: await r.text()}))`);
    log(`  ${method} ${path} -> ${r?.status} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    try { return JSON.parse(r.body); } catch { return { raw: String(r?.body ?? r).slice(0, 200) }; }
  };
  log(`set token: ${JSON.stringify(await api("POST", "/api/auth/token", { new: "emkay-test-token" }))}`);
  const before = JSON.parse(await py("import json; from emkay_mobile import boot; json.dumps(sorted(boot._manager.plugin_skills))"));
  log(`skills before: ${before.length}`);

  const job = await api("POST", "/api/plugins/install", { package: pkg });
  log(`install job: ${JSON.stringify(job).slice(0, 200)}`);
  let state = job;
  for (let i = 0; i < 120 && job.id && !["done", "failed", "error"].includes(state.state); i++) {
    await sleep(5000);
    state = await api("GET", `/api/plugins/jobs/${job.id}`);
  }
  log(`install finished: state=${state.state} returncode=${state.returncode}`);
  for (const line of (state.lines || []).slice(-15)) log(`  | ${line}`);
  await sleep(5000);
  const after = JSON.parse(await py("import json; from emkay_mobile import boot; json.dumps(sorted(boot._manager.plugin_skills))"));
  log(`skills after: ${after.length}; new: ${after.filter((s) => !before.includes(s)).join(", ")}; gone: ${before.filter((s) => !after.includes(s)).join(", ")}`);

  await sleep(60000);   // padatious trains the new skill's intents
  const t = Date.now();
  await js(`window.emkay.call("say", {text: ${JSON.stringify(ask)}})`);
  log(`asked "${ask}" (call returned in ${((Date.now() - t) / 1000).toFixed(1)}s)`);
  await sleep(10000);

  // ovos-core refuses to uninstall packages listed in OVOS' constraints (all
  // official skills), as on a device; the browser pip itself is tried here
  log(`pip uninstall: ${await py(`from emkay_mobile import pip\ntry:\n    out = pip.run(['uninstall', '-y', ${JSON.stringify(pkg)}])\nexcept RuntimeError as e:\n    out = 'FAILED ' + str(e)\nout`)}`);
  // what ovos-core's installer emits after a successful removal; SkillManager
  // then unloads the skill
  await py("from emkay_mobile import boot\nfrom ovos_bus_client.message import Message\nboot.bus().emit(Message('ovos.pip.uninstall.complete'))");
  await sleep(3000);
  const removed = JSON.parse(await py("import json; from emkay_mobile import boot; json.dumps(sorted(boot._manager.plugin_skills))"));
  log(`skills after uninstall: ${removed.length}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-80)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
