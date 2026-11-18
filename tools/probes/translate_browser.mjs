// Add language (Emkay Dev, translate.py + mt.js) in a real headless Chromium:
// a skill's locale/en-US files sent to a dev Emkay, translated there into
// <lang>, and written to <out dir>/<lang>/ with a report.
//
//   CHROME=... node tools/probes/translate_browser.mjs <repo dir> <lang> <out dir>
// Emkay must be served on http://127.0.0.1:8080 (tools/serve.py).
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";

const repoDir = path.resolve(process.argv[2]);
const [toLang, outDir] = [process.argv[3], path.resolve(process.argv[4] || "/tmp/translated")];
const pkg = fs.readdirSync(repoDir).find((d) => fs.existsSync(path.join(repoDir, d, "__init__.py")) && d !== "tests");
const skillDir = path.join(repoDir, pkg);
const parent = `<!doctype html><meta charset=utf-8><title>template parent</title>
<iframe id=f src="http://127.0.0.1:8080/?dev" allow="microphone; autoplay" style="width:390px;height:700px"></iframe>
<script>
const f = document.getElementById("f");
let nid = 0; const waiting = new Map();
window.said = []; window.hello = null; window.errors = []; window.trace = [];
addEventListener("message", (e) => {
  const d = e.data; if (!d || d.emkayDev !== 1) return;
  if (d.op === "hello") window.hello = d;
  if (d.op === "result") { waiting.get(d.id)?.(d); waiting.delete(d.id); }
  if (d.op === "log") { window.trace.push("log " + d.record.level + " " + String(d.record.msg).slice(0, 200)); if (d.record.level === "ERROR") window.errors.push(d.record.msg); }
  if (d.op === "bus") { try { const m = JSON.parse(d.raw); window.trace.push("bus " + m.type);
    if (m.type === "speak" || m.type === "ovos.utterance.speak") window.said.push(m.data.utterance);
    if (m.type === "mycroft.skill.handler.error") window.errors.push(m.data.exception || "handler error"); } catch {} }
});
window.op = (op, args = {}) => new Promise((r) => { const id = ++nid; waiting.set(id, r);
  f.contentWindow.postMessage({ emkayDev: 1, op, id, ...args }, "http://127.0.0.1:8080"); });
setInterval(() => { if (!window.hello?.ready) f.contentWindow.postMessage({ emkayDev: 1, op: "hello" }, "http://127.0.0.1:8080"); }, 1000);
</script>`;
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(parent); })
  .listen(8093, "127.0.0.1");
const port = 9353;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-translate",
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
  await send("Page.navigate", { url: "http://127.0.0.1:8093/" });
  await until(`window.hello?.ready && window.hello`, 400, "a ready dev Emkay");
  log("emkay ready");
  const en = path.join(skillDir, "locale", "en-US");
  const files = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else files[path.relative(en, p)] = fs.readFileSync(p, "utf8");
    }
  })(en);
  log(`translating ${Object.keys(files).length} files into ${toLang}`);
  const t0b = Date.now();
  const r = await op("translate", { lang: toLang, files }, 1200);
  const res = r.result;
  if (!r.ok || !res?.ok) throw new Error(`translate: ${JSON.stringify(r).slice(0, 800)}`);
  log(`translated in ${((Date.now() - t0b) / 1000).toFixed(0)} s with ${res.model} (${res.repo})`);
  const dir = path.join(outDir, toLang);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [p, text] of Object.entries(res.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
  fs.writeFileSync(path.join(outDir, `${toLang}.report.json`), JSON.stringify({ ...res, files: Object.keys(res.files) }, null, 1));
  log(`files: ${Object.keys(res.files).length} written, copied ${res.copied.length}, dropped lines ${res.dropped.length}, problems ${res.problems.length}`);
  for (const d of res.dropped.slice(0, 8)) log(`  dropped ${d.file}: ${JSON.stringify(d.line)} – ${d.reason}`);
  for (const p of res.problems.slice(0, 8)) log(`  ${p.severity} ${p.file}: ${p.rule} – ${p.message}`);
  log("ALL OK");
} catch (e) {
  log(`FAILED: ${e.message}`);
  for (const l of (await js(`window.trace?.slice(-25)`)) || []) console.log("   " + l);
  failed++;
} finally {
  process.exitCode = failed ? 1 : 0;
  ws.close();
  chrome.kill();
  server.close();
}
