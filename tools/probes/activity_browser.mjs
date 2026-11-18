// "What's happening?" (#50) in a real (headless) Chromium: ask a few things,
// open menu → What's happening?, and read what it shows: heard, understood
// (skill, intent, pipeline), answered, and what left the device.
//
//   CHROME=~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
//     node tools/probes/activity_browser.mjs [url] [screenshot.png]
import { spawn } from "child_process";
import fs from "fs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const shot = process.argv[3] || "";
const port = 9347;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-activity",
  "--window-size=430,932", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  `--lang=${process.env.PHONE_LANG || "en-US"}`, `--accept-lang=${process.env.PHONE_LANG || "en-US"}`, "about:blank"], { stdio: "ignore" });
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
  await js(`document.getElementById("start").click(); true`);
  await sleep(45000);   // padatious' first compile
  const questions = /^da/.test(process.env.PHONE_LANG || "")
    ? ["hvad er klokken", "hvad er hovedstaden i Frankrig", "blorp zorp quux"]
    : ["what time is it", "what is the capital of France", "blorp zorp quux"];
  for (const q of questions) {
    await js(`window.emkay.call("say", {text: ${JSON.stringify(q)}})`);
    log(`asked "${q}"`);
    await sleep(14000);
  }
  await js(`document.getElementById("menu-button").click(); true`);
  await until(`!document.getElementById("menu").hidden`, 10, "the menu");
  log(`menu entry: "${await js(`document.querySelector("#menu-activity b").textContent`)}" shown=${await js(`!document.getElementById("menu-activity").hidden`)}`);
  await js(`document.getElementById("menu-activity").click(); true`);
  await until(`document.querySelectorAll("#activity-list .act-turn").length > 0`, 20, "the view");
  await sleep(3000);
  log(`setup: ${await js(`document.getElementById("activity-setup").innerText.replace(/\\n/g, " | ")`)}`);
  const turns = await js(`[...document.querySelectorAll("#activity-list .act-turn")].map((b) =>
    [...b.querySelectorAll(".act-line")].map((l) => l.className.replace("act-line act-", "") + ": " +
      l.querySelector(".act-text").textContent + (l.querySelector(".act-sub") ? " [" + l.querySelector(".act-sub").textContent + "]" : "")).join("\\n    "))`);
  log(`types seen: ${JSON.stringify(await js(`[...new Set(window.emkay.activity.types())]`))}`);
  log(`turns: ${turns.length}`);
  for (const tn of turns) console.log(`  - ${tn}`);
  if (shot) {
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(shot, Buffer.from(r.result.data, "base64"));
    log(`screenshot ${shot}`);
  }
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  ws.close();
  chrome.kill();
}
