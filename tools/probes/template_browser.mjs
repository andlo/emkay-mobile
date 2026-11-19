// An Emkay Dev template (emkay-voice/template-*) in a real headless Chromium,
// as the extension runs it: load the skill as files into Emkay (?dev), run its
// golden utterances in the language Emkay speaks, then talk to it.
//
//   CHROME=... PHONE_LANG=en-US node tools/probes/template_browser.mjs <repo dir> [<script.json>]
//
// <script.json>: {"<lang>": [["say this", "regex the answer must match"], ...]}
// – a conversation, each line said once the previous answer was spoken. An
// answer "bus:<regex>" is a bus message (as JSON) instead of something said:
// a media skill plays, it does not speak.
// A PHAL plugin (an opm.phal entry point in pyproject.toml) is started the
// same way (load with kind "plugin"); it has no golden utterances. A line
// "emit:<type> <json data>" sends that bus message instead of saying something.
// Emkay must be served on http://127.0.0.1:8080 (tools/serve.py).
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";

const repoDir = path.resolve(process.argv[2]);
const script = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], "utf8")) : {};
const pyproject = fs.readFileSync(path.join(repoDir, "pyproject.toml"), "utf8");
const phal = pyproject.match(/\[project\.entry-points\.["']?opm\.phal["']?\]\s*\n\s*["']?([^"'=\s]+)["']?\s*=\s*["']([^"']+)["']/);
const pkg = phal ? phal[2].split(":")[0].split(".")[0]
  : fs.readdirSync(repoDir).find((d) => fs.existsSync(path.join(repoDir, d, "__init__.py")) && d !== "tests");
const skillDir = path.join(repoDir, pkg);
const parent = `<!doctype html><meta charset=utf-8><title>template parent</title>
<iframe id=f src="http://127.0.0.1:8080/?dev" allow="microphone; autoplay" style="width:390px;height:700px"></iframe>
<script>
const f = document.getElementById("f");
let nid = 0; const waiting = new Map();
window.said = []; window.hello = null; window.errors = []; window.trace = []; window.raw = [];
addEventListener("message", (e) => {
  const d = e.data; if (!d || d.emkayDev !== 1) return;
  if (d.op === "hello") window.hello = d;
  if (d.op === "result") { waiting.get(d.id)?.(d); waiting.delete(d.id); }
  if (d.op === "log") { window.trace.push((d.record.t % 1000).toFixed(1) + " log " + d.record.level + " " + String(d.record.msg).slice(0, 200)); if (d.record.level === "ERROR") window.errors.push(d.record.msg); }
  if (d.op === "bus") { window.raw.push(d.raw); if (window.raw.length > 800) window.raw.splice(0, 200); try { const m = JSON.parse(d.raw); window.trace.push((Date.now() / 1000 % 1000).toFixed(1) + " bus " + m.type);
    if (m.type === "speak" || m.type === "ovos.utterance.speak") window.said.push(m.data.utterance);
    if (m.type === "mycroft.skill.handler.error") window.errors.push(m.data.exception || "handler error"); } catch {} }
});
window.op = (op, args = {}) => new Promise((r) => { const id = ++nid; waiting.set(id, r);
  f.contentWindow.postMessage({ emkayDev: 1, op, id, ...args }, "http://127.0.0.1:8080"); });
setInterval(() => { if (!window.hello?.ready) f.contentWindow.postMessage({ emkayDev: 1, op: "hello" }, "http://127.0.0.1:8080"); }, 1000);
</script>`;
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(parent); })
  .listen(8092, "127.0.0.1");
const port = Number(process.env.PROBE_PORT || 9349);   // another probe on this machine may have 9349
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-template",
  "--window-size=1000,800", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  `--lang=${process.env.PHONE_LANG || "en-US"}`, `--accept-lang=${process.env.PHONE_LANG || "en-US"}`,
  "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page" && t.url.startsWith("about:blank")); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
// CPUPROF=1: Chrome's CPU profiler on Emkay's worker (where Pyodide runs),
// reported for the seconds around "ready" and the first question (#4)
let workerSession = null;
const sendS = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.method === "Target.attachedToTarget" && process.env.CPUPROF) {
    const { sessionId, targetInfo } = m.params;
    if (targetInfo.type === "worker" && /worker\.js/.test(targetInfo.url)) {
      workerSession = sessionId;
      sendS("Profiler.enable", {}, sessionId).then(() => sendS("Profiler.setSamplingInterval", { interval: 500 }, sessionId))
        .then(() => sendS("Profiler.start", {}, sessionId)).then(() => sendS("Runtime.runIfWaitingForDebugger", {}, sessionId));
    } else {
      sendS("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
      sendS("Runtime.runIfWaitingForDebugger", {}, sessionId);
    }
  }
};
const send = (method, params = {}) => sendS(method, params);
async function cpuReport(fromWall, toWall) {
  if (!workerSession) { log("cpuprof: no worker attached"); return; }
  const stopWall = Date.now();
  const r = await sendS("Profiler.stop", {}, workerSession);
  const prof = r.result?.profile;
  if (!prof) { log("cpuprof: no profile " + JSON.stringify(r).slice(0, 200)); return; }
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  let t = prof.startTime;
  const self = new Map(), files = new Map();
  for (let i = 0; i < prof.samples.length; i++) {
    t += prof.timeDeltas[i];
    const wall = stopWall - (prof.endTime - t) / 1000;
    if (wall < fromWall || wall > toWall) continue;
    const n = byId.get(prof.samples[i]); const cf = n.callFrame;
    const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber}`;
    const dt = (prof.timeDeltas[i + 1] ?? prof.timeDeltas[i]) / 1000;
    self.set(key, (self.get(key) || 0) + dt);
    const f = cf.url.split("/").pop() || cf.functionName;
    files.set(f, (files.get(f) || 0) + dt);
  }
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  log(`cpuprof: worker, ${((toWall - fromWall) / 1000).toFixed(1)} s window`);
  for (const [k, v] of top(files, 10)) log(`  file ${(v / 1000).toFixed(2)} s  ${k}`);
  for (const [k, v] of top(self, 25)) log(`  self ${(v / 1000).toFixed(2)} s  ${k}`);
}
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function until(expression, seconds, what) {
  for (let i = 0; i < seconds * 2; i++) { const v = await js(expression); if (v) return v; await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
}
const op = async (name, args = {}, seconds = 90) => {
  const r = await js(`Promise.race([window.op(${JSON.stringify(name)}, ${JSON.stringify(args)}), new Promise((r) => setTimeout(() => r({ hung: true }), ${seconds * 1000}))])`);
  if (r?.hung) {
    log(`${name} gave no answer in ${seconds} s; last of the bus and log:`);
    for (const l of (await js(`window.trace.slice(-40)`)) || []) console.log("   " + l);
    throw new Error(`${name} hung`);
  }
  return r;
};
function filesOf(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesOf(p, base, out);
    else out[path.relative(base, p)] = fs.readFileSync(p).toString("base64");
  }
  return out;
}
function deps() {
  const t = fs.readFileSync(path.join(repoDir, "pyproject.toml"), "utf8");
  const m = t.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

let failed = 0;
try {
  if (process.env.CPUPROF) await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:8092/" });
  const hello = await until(`window.hello?.ready && window.hello`, 400, "a ready dev Emkay");
  const lang = hello.lang;
  log(`emkay ready, speaks ${lang}`);
  const readyWall = Date.now();
  if (process.env.PY_BEFORE) {   // PY_BEFORE="<python>": run before the first question (e.g. start a profiler)
    const r = await op("python", { code: process.env.PY_BEFORE }, 120);
    log(`python before: ${JSON.stringify(r.result ?? r.error).slice(0, 300)}`);
  }
  if (process.env.FIRST) {   // FIRST="what time is it": how long the first answer after "ready" takes (#4)
    for (const round of (process.env.FIRST_ONLY ? ["first"] : ["first", "second"])) {
      await js(`window.said = []; window.trace = []`);
      const t1 = Date.now();
      log(`asked at ${(Date.now() / 1000 % 1000).toFixed(1)}`);
      await op("say", { text: process.env.FIRST });
      await until(`window.said.length`, 120, `an answer to ${process.env.FIRST}`);
      log(`${round} answer after ${((Date.now() - t1) / 1000).toFixed(1)} s: ${JSON.stringify(await js("window.said"))}`);
      if (process.env.CPUPROF && round === "first") await cpuReport(readyWall - 3000, Date.now());
      for (const l of await js(`window.trace.filter((l) => new RegExp(${JSON.stringify(process.env.FIRST_TRACE || "padaos|train|warm|regex")}, "i").test(l))`)) log(`  ${l}`);
      await sleep(3000);
    }
  }
  if (process.env.PY) {   // PY="<python>": run it in Emkay's Python and log what the last line gives
    const r = await op("python", { code: process.env.PY }, 900);
    log(`python: ${JSON.stringify(r.result ?? r.error)}`);
  }
  const goldFile = path.join(repoDir, "test/end2end", `golden_utterances_${lang}.jsonl`);
  const gold = phal || !fs.existsSync(goldFile) ? [] : fs.readFileSync(goldFile, "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const r = phal
    ? await op("load", { skillId: phal[1], kind: "plugin", entry: phal[2], files: filesOf(skillDir), requirements: deps() })
    : await op("load", { skillId: gold[0].skill_id, files: filesOf(skillDir), requirements: deps() });
  log(`load: ok=${r.result?.ok} trained=${r.result?.trained} intents=${JSON.stringify(r.result?.intents)} listens=${JSON.stringify(r.result?.listens)} problems=${JSON.stringify(r.result?.problems)}`);
  if (!r.result?.ok) failed++;
  if (process.env.RELOAD) {   // RELOAD=1: load it a second time, as each save does
    const again = phal
      ? await op("load", { skillId: phal[1], kind: "plugin", entry: phal[2], files: filesOf(skillDir), requirements: deps() })
      : await op("load", { skillId: gold[0].skill_id, files: filesOf(skillDir), requirements: deps() });
    log(`load again: ok=${again.result?.ok} problems=${JSON.stringify(again.result?.problems)}`);
    if (!again.result?.ok) failed++;
  }
  await sleep(2000);
  for (const row of gold) {
    const t = await op("test", { row });
    log(`golden ${JSON.stringify(row.utterance)}: ${t.result?.status} – ${t.result?.detail}`);
    if (t.result?.status !== "pass") failed++;
    await js(`window.said = []`);
    await sleep(1500);
  }
  if (process.env.SHOT) {   // "Tap to start", as a person would, so the face and the screen run
    const el = await js(`(() => { const r = document.getElementById("f").getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: el[0] + el[2] / 2, y: el[1] + 462, button: "left", clickCount: 1 });
    }
    await sleep(4000);
  }
  // the conversation
  await op("say", { text: "stop" }).catch(() => {});
  await sleep(2000);
  for (const [text, expect] of script[lang] || script[lang.split("-")[0]] || []) {
    await js(`window.said = []; window.raw = []; window.trace = []`);
    if (text.startsWith("emit:")) {
      const [type, ...rest] = text.slice(5).split(" ");
      const data = rest.length ? rest.join(" ") : "{}";
      await op("python", { code: `from emkay_mobile import boot\nimport json\nboot.emit(${JSON.stringify(type)}, json.loads(${JSON.stringify(data)}))` });
    } else {
      await op("say", { text });
    }
    const onBus = expect.startsWith("bus:");
    const re = new RegExp(onBus ? expect.slice(4) : expect, "i");
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await sleep(400);
      ok = await js(`window.${onBus ? "raw" : "said"}.some((s) => ${re}.test(s))`);
    }
    const said = await js(`window.said`);
    log(`say ${JSON.stringify(text)} -> ${ok ? "ok" : "NO MATCH /" + expect + "/"} ${JSON.stringify(said)}`);
    if (!ok) failed++;
    if (process.env.DUMP_BUS) {   // DUMP_BUS=1: what went on the bus, and where the session was
      const seen = await js(`window.raw.map((r) => { try { const m = JSON.parse(r); return m.type + " " + ((m.context||{}).session||{}).session_id; } catch (e) { return "?"; } })`);
      log(`  bus: ${seen.join(" | ")}`);
    }
    if (process.env.DUMP_TRACE) {   // DUMP_TRACE=<regex>: those log and bus lines
      const lines = await js(`window.trace.filter((l) => new RegExp(${JSON.stringify(process.env.DUMP_TRACE)}).test(l))`);
      for (const l of lines) log(`  trace: ${l}`);
    }
    if (process.env.DUMP_RAW) {   // DUMP_RAW=<regex>: those bus messages in full
      const raws = await js(`window.raw.filter((r) => new RegExp(${JSON.stringify(process.env.DUMP_RAW)}).test(r))`);
      for (const r of raws) log(`  raw: ${r.slice(0, 3000)}`);
    }
    await sleep(800);
  }
  if (process.env.SHOT) {   // SHOT=file.png: a picture of Emkay after the conversation
    await sleep(3000);
    const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 400, height: 710, scale: 1 } });
    fs.writeFileSync(process.env.SHOT, Buffer.from(r.result.data, "base64"));
    log(`screenshot: ${process.env.SHOT}`);
  }
  const errors = await js(`window.errors.slice(-3)`);
  if (errors?.length) log(`errors: ${JSON.stringify(errors).slice(0, 600)}`);
  log(failed ? `FAILED: ${failed}` : "ALL OK");
} catch (e) {
  log(`FAILED: ${e.message}`);
  failed++;
} finally {
  process.exitCode = failed ? 1 : 0;
  ws.close();
  chrome.kill();
  server.close();
}
