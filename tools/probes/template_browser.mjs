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
// Emkay must be served on http://127.0.0.1:8080 (tools/serve.py).
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";

const repoDir = path.resolve(process.argv[2]);
const script = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], "utf8")) : {};
const pkg = fs.readdirSync(repoDir).find((d) => fs.existsSync(path.join(repoDir, d, "__init__.py")) && d !== "tests");
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
  if (d.op === "log") { window.trace.push("log " + d.record.level + " " + String(d.record.msg).slice(0, 200)); if (d.record.level === "ERROR") window.errors.push(d.record.msg); }
  if (d.op === "bus") { window.raw.push(d.raw); if (window.raw.length > 800) window.raw.splice(0, 200); try { const m = JSON.parse(d.raw); window.trace.push("bus " + m.type);
    if (m.type === "speak" || m.type === "ovos.utterance.speak") window.said.push(m.data.utterance);
    if (m.type === "mycroft.skill.handler.error") window.errors.push(m.data.exception || "handler error"); } catch {} }
});
window.op = (op, args = {}) => new Promise((r) => { const id = ++nid; waiting.set(id, r);
  f.contentWindow.postMessage({ emkayDev: 1, op, id, ...args }, "http://127.0.0.1:8080"); });
setInterval(() => { if (!window.hello?.ready) f.contentWindow.postMessage({ emkayDev: 1, op: "hello" }, "http://127.0.0.1:8080"); }, 1000);
</script>`;
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(parent); })
  .listen(8092, "127.0.0.1");
const port = 9349;
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
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
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:8092/" });
  const hello = await until(`window.hello?.ready && window.hello`, 400, "a ready dev Emkay");
  const lang = hello.lang;
  log(`emkay ready, speaks ${lang}`);
  const gold = fs.readFileSync(path.join(repoDir, "test/end2end", `golden_utterances_${lang}.jsonl`), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const r = await op("load", { skillId: gold[0].skill_id, files: filesOf(skillDir), requirements: deps() });
  log(`load: ok=${r.result?.ok} trained=${r.result?.trained} intents=${JSON.stringify(r.result?.intents)} problems=${JSON.stringify(r.result?.problems)}`);
  if (!r.result?.ok) failed++;
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
    await op("say", { text });
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
