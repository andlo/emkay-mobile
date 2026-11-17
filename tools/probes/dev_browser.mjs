// Emkay Dev (?dev, web/dev.js + py/emkay_mobile/dev.py) in a real headless
// Chromium: a parent page (as the VS Code extension's panel is) frames
// Emkay with ?dev, sends a skill as files, talks to it, runs its golden
// utterances, changes the skill and loads it again.
//
//   CHROME=... node tools/probes/dev_browser.mjs [skill dir]
//
// Emkay must be served on http://127.0.0.1:8080 (tools/serve.py; ci.py does
// it). The probe serves the parent page itself, tools/probes/dev_parent.html,
// on http://127.0.0.1:8091 – another origin, as VS Code's webview is.
// <skill dir> is a skill's package folder (__init__.py, locale/) next to its
// test/end2end/ folder; the default is the template's hello skill in
// tools/probes/dev_skill.
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";

const here = path.dirname(new URL(import.meta.url).pathname);
const given = process.argv.slice(2).find((a) => !/^https?:/.test(a));   // ci.py passes the site URL
const skillDir = path.resolve(given || path.join(here, "dev_skill/ovos_skill_hello"));
const parentPage = fs.readFileSync(path.join(here, "dev_parent.html"));
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(parentPage);
}).listen(8091, "127.0.0.1");
const url = "http://127.0.0.1:8091/";
const repoDir = path.dirname(skillDir);
const port = 9341;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-dev",
  "--window-size=1000,800", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  `--lang=${process.env.PHONE_LANG || "en-US"}`, `--accept-lang=${process.env.PHONE_LANG || "en-US"}`,
  "about:blank"], { stdio: "ignore" });
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
const op = (name, args = {}) => js(`window.op(${JSON.stringify(name)}, ${JSON.stringify(args)})`);

/** The skill folder as {relative path: base64}, as the extension sends it. */
function filesOf(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesOf(p, base, out);
    else out[path.relative(base, p)] = fs.readFileSync(p).toString("base64");
  }
  return out;
}
function goldenRows(lang) {
  const f = path.join(repoDir, "test/end2end", `golden_utterances_${lang}.jsonl`);
  return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

try {
  await send("Page.enable");
  await send("Page.navigate", { url });
  const hello = await until(`window.hello?.ready && window.hello`, 400, "a ready dev Emkay");
  log(`hello: ready=${hello.ready} version=${hello.version}`);

  // the golden utterances in the language Emkay speaks (the browser's)
  const rows = goldenRows(hello.lang);
  const skillId = rows[0].skill_id;
  const r1 = await op("load", { skillId, files: filesOf(skillDir), requirements: [] });
  log(`load: ok=${r1.ok} ${JSON.stringify(r1.result)}`);
  await sleep(3000);   // padatious learns the new sentences

  for (const row of rows) {
    const r = await op("test", { row });
    log(`test ${JSON.stringify(row.utterance)}: ${r.result?.status} – ${r.result?.detail} – said ${JSON.stringify(r.result?.spoke)}`);
  }
  if (process.env.WAIT_AGAIN) {
    for (const s of process.env.WAIT_AGAIN.split(",")) {
      await sleep(Number(s) * 1000);
      const r = await op("test", { row: rows[1] });
      log(`after ${s} s more: ${r.result?.status} – ${r.result?.detail}`);
    }
  }
  const otherLang = hello.lang.startsWith("en") ? "da-DK" : "en-US";
  const other = await op("test", { row: { utterance: "what is 2 plus 2", lang: otherLang } });
  log(`other language: ${other.result?.status} – ${other.result?.detail}`);

  // change the answer and load again: the new one is spoken
  const changed = filesOf(skillDir);
  changed[`locale/${hello.lang}/hello.dialog`] = Buffer.from("Reloaded and ready.\n").toString("base64");
  const r2 = await op("load", { skillId, files: changed, requirements: [] });
  log(`reload: ok=${r2.ok} ${r2.result?.ok} intents=${JSON.stringify(r2.result?.intents)}`);
  await sleep(1500);
  const after = await op("test", { row: rows[0] });
  log(`after reload: ${after.result?.status} said ${JSON.stringify(after.result?.spoke)}`);

  // a broken skill says why
  const broken = filesOf(skillDir);
  broken["__init__.py"] = Buffer.from("this is not python\n").toString("base64");
  const r3 = await op("load", { skillId, files: broken, requirements: [] });
  log(`broken: ok=${r3.result?.ok} problems=${JSON.stringify(r3.result?.problems)}`);

  const logs = await js(`window.log.length`);
  const mine = await js(`window.log.filter((r) => r.mine).length`);
  const bus = await js(`window.bus.length`);
  log(`log lines: ${logs} (${mine} from the skill), bus messages: ${bus}`);
  const errs = await js(`JSON.stringify(window.log.filter((r) => r.level === "ERROR").slice(-3).map((r) => r.msg.slice(0, 300)))`);
  log(`last errors: ${errs}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (process.env.KEEP) { log("KEEP: Chromium stays up on port " + port); await new Promise(() => {}); }
  chrome.kill();
  server.close();
}
