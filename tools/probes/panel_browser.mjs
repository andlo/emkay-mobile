// End-to-end check of the settings panel in a real (headless) Chromium:
// Service Worker, page bridge, worker, the stock ovos-control-panel.
//
//   CHROME=~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
//     node tools/probes/panel_browser.mjs [http://127.0.0.1:8080/] [out.png]
//
// Uses a throw-away profile in /tmp and talks to Chromium over CDP.
import { spawn } from "child_process";
import fs from "fs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const shot = process.argv[3] || "build/panel.png";
const port = 9333;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
/** Evaluate an expression in the page (awaits promises). */
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

try {
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  log(`booted: ${await js(`document.getElementById("boot-text").textContent`)}`);
  await js(`document.getElementById("start").click(); true`);
  log(`service worker: ${await js(`navigator.serviceWorker.ready.then((r) => r.active.state + " " + r.scope)`)}`);
  log(`controlled: ${await js(`!!navigator.serviceWorker.controller`)}`);

  await js(`document.getElementById("menu-panel").click(); true`);
  const doc = `document.getElementById("panel-frame").contentDocument`;
  const title = await until(`${doc}?.readyState === "complete" && ${doc}.title`, 120, "panel page");
  log(`panel: "${title}" at ${await js(`${doc}.location.pathname`)}`);
  log(`panel text: ${JSON.stringify((await js(`${doc}.body.innerText`)).slice(0, 200))}`);

  const link = await js(`[...${doc}.querySelectorAll("a")].map((a) => a.getAttribute("href")).slice(0, 8).join(" ")`);
  log(`panel links: ${link}`);
  await js(`(${doc}.querySelector('a[href$="controls"]') || {}).click?.(); true`);
  await sleep(1500);
  const t2 = await until(`${doc}?.readyState === "complete" && ${doc}.location.pathname.endsWith("controls") && ${doc}.title`, 60, "controls page");
  log(`after click: "${t2}" at ${await js(`${doc}.location.pathname`)}`);

  const status = await js(`document.getElementById("panel-frame").contentWindow.fetch("/api/status").then((r) => r.status + " " + r.headers.get("content-type"))`);
  log(`fetch /api/status from the panel: ${status}`);
  const post = await js(`document.getElementById("panel-frame").contentWindow.fetch("/api/logout", {method: "POST"}).then((r) => r.status)`);
  log(`POST /api/logout from the panel (same site): ${post}`);
  for (const api of ["/api/device/volume", "/api/health"]) {
    const body = await js(`document.getElementById("panel-frame").contentWindow.fetch("${api}").then((r) => r.text())`);
    log(`GET ${api}: ${body.slice(0, 400)}`);
  }
  log(`panel accent colour: ${await js(`getComputedStyle(${doc}.documentElement).getPropertyValue("--accent")`)}`);

  if (process.env.EMKAY_TOKEN_TEST) {
    // the access-token round trip: set one, sign out, be refused, sign in
    const w = `document.getElementById("panel-frame").contentWindow`;
    const req = (method, path, body) => js(`${w}.fetch("${path}", {method: "${method}",
      headers: {"content-type": "application/json"}${body ? `, body: JSON.stringify(${JSON.stringify(body)})` : ""}})
      .then(async (r) => r.status + " " + (await r.text()).slice(0, 80))`);
    log(`set token: ${await req("POST", "/api/auth/token", { new: "emkay-test-token" })}`);
    log(`still signed in, GET /api/device/volume: ${await req("GET", "/api/device/volume")}`);
    log(`sign out: ${await req("POST", "/api/logout")}`);
    log(`signed out, GET /api/device/volume: ${await req("GET", "/api/device/volume")}`);
    log(`sign in with a wrong token: ${await req("POST", "/api/login", { token: "wrong-token-123" })}`);
    log(`sign in: ${await req("POST", "/api/login", { token: "emkay-test-token" })}`);
    log(`signed in, GET /api/device/volume: ${await req("GET", "/api/device/volume")}`);
  }

  const png = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(shot, Buffer.from(png.result.data, "base64"));
  log(`screenshot: ${shot}`);
  const errors = await js(`(window.__errors || []).join("\\n")`);
  if (errors) log(`errors: ${errors}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
  const png = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(shot, Buffer.from(png.result.data, "base64"));
} finally {
  ws.close();
  chrome.kill();
}
