// Print the JS/WebAssembly call stack of a busy Node process.
// For a Pyodide run that hangs inside C code (no Python frames to trace):
//   kill -USR1 <pid>      # opens the inspector on 127.0.0.1:9229
//   node tools/probes/cdp_stack.mjs [samples]
// Pauses the process a few times, prints the top frames, and resumes it.
const [{ webSocketDebuggerUrl }] = await (await fetch("http://127.0.0.1:9229/json")).json();
const ws = new WebSocket(webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
let onPaused = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Debugger.paused" && onPaused) onPaused(m.params);
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Debugger.enable");
const samples = Number(process.argv[2] || 3);
for (let s = 0; s < samples; s++) {
  const paused = new Promise((r) => (onPaused = r));
  await send("Debugger.pause");
  const p = await paused;
  console.log(`--- sample ${s + 1} ---`);
  for (const f of p.callFrames.slice(0, 40)) console.log("  " + (f.functionName || "(anonymous)") + "  " + (f.url || "").split("/").pop());
  await send("Debugger.resume");
  await new Promise((r) => setTimeout(r, 1500));
}
ws.close();
