// The start screen's bar during a boot, in a real (headless) Chromium: the
// text and the bar's width every 250 ms, then whether the bar ever went back.
// Boots twice in one profile, as a user does: the second boot uses the step
// times the first one learned (localStorage emkay.bootTimes, app.js bootBar).
//
//   CHROME=~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
//     node tools/probes/bootbar_browser.mjs [url] [boots]
//
// Uses a throw-away profile in /tmp and talks to Chromium over CDP.
import { spawn } from "child_process";
import { rmSync } from "fs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const boots = Number(process.argv[3] || 2);
const port = 9341;
const profile = "/tmp/emkay-chrome-bootbar";
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=390,844", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
      .find((t) => t.type === "page");
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
let t0 = Date.now();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  // the worker's own "[emkay] …" lines (boot.py's timings), between the samples
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable", sessionId: m.params.sessionId }));
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.runIfWaitingForDebugger", sessionId: m.params.sessionId }));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.sessionId) {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (text.startsWith("[emkay]")) console.log(`       ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  worker ${text.slice(0, 160)}`);
  }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  return r.result?.result?.value;
}
const SAMPLE = `(() => { const b = document.getElementById("boot-bar"), s = document.getElementById("start");
  return { text: document.getElementById("boot-text")?.innerText, w: parseFloat(b?.style.width) || 0,
           up: !!s && !s.hidden }; })()`;

try {
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  for (let n = 1; n <= boots; n++) {
    await send("Page.navigate", { url });
    t0 = Date.now();
    let last = { w: -1, text: "" }, back = 0, jumps = [];
    for (;;) {
      await sleep(250);
      const s = await js(SAMPLE);
      if (!s) continue;
      const t = ((Date.now() - t0) / 1000).toFixed(1);
      if (s.w < last.w) back++;
      if (s.w - last.w > 15 && last.w >= 0) jumps.push(`${t}s +${(s.w - last.w).toFixed(0)}%`);
      if (s.text !== last.text || Math.floor(s.w / 5) !== Math.floor(last.w / 5))
        console.log(`boot ${n} ${t.padStart(5)}s ${s.w.toFixed(1).padStart(5)}%  ${s.text}`);
      last = s;
      if (s.up || Date.now() - t0 > 400000) break;
    }
    console.log(`boot ${n}: ${((Date.now() - t0) / 1000).toFixed(1)}s, went back ${back}×, jumps >15%: ${jumps.join(", ") || "none"}`);
    console.log(`learned: ${await js(`localStorage.getItem("emkay.bootTimes")`)}`);
  }
} finally {
  ws.close();
  chrome.kill();
}
