// Is Emkay installable as an app (manifest, icons, service worker), and does
// the control panel open in its Simple view? Headless Chromium over CDP.
//
//   CHROME=... node tools/probes/installable_browser.mjs [url]
import { spawn } from "child_process";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const port = 9345;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-installable",
  "--window-size=390,844", "--no-first-run", "--lang=en-US", "about:blank"], { stdio: "ignore" });
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
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
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  const manifest = await send("Page.getAppManifest");
  const errs = manifest.result?.errors || [];
  log(`manifest errors: ${errs.length ? JSON.stringify(errs) : "none"}`);
  const inst = await send("Page.getInstallabilityErrors");
  const ie = (inst.result?.installabilityErrors || []).map((e) => e.errorId);
  log(`installability errors: ${ie.length ? ie.join(", ") : "none"}`);
  await js(`document.getElementById("start").click(); true`);
  await sleep(2000);
  await js(`document.getElementById("menu-panel").click(); true`);
  const navCount = `document.getElementById("panel-frame").contentDocument?.querySelectorAll("nav a").length`;
  await until(`(${navCount}) > 0`, 120, "the panel's page list");
  // every page is in the menu; the advanced groups start folded (hidden)
  const shown = `[...document.getElementById("panel-frame").contentDocument.querySelectorAll("nav a")].filter(a => !a.closest(".nav-links[hidden]"))`;
  log(`panel menu: ${await js(`${shown}.length`)} of ${await js(navCount)} pages shown (${await js(`${shown}.map(a => a.getAttribute("href")).join(" ")`)})`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  ws.close();
  chrome.kill();
}
