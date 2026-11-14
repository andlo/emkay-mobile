// Emkay Mobile – the page side: screen, microphone and speaker.
// OVOS itself runs in worker.js; ovos-visage draws the screen unchanged.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const kiosk = params.has("kiosk");

// ---------------------------------------------------------------- worker
const worker = new Worker("worker.js", { type: "module" });
let nextId = 1;
const waiting = new Map();
function call(cmd, args = {}, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, ...args }, transfer);
  });
}

const guiSockets = new Set();
worker.onmessage = ({ data }) => {
  if (data.id) {
    const w = waiting.get(data.id);
    waiting.delete(data.id);
    return data.error ? w.reject(new Error(data.error)) : w.resolve(data.result);
  }
  switch (data.kind) {
    case "status": return bootStatus(data.text, data.progress);
    case "gui": for (const s of guiSockets) s.deliver(data.payload); return;
    case "audio": return speaker.enqueue(data.data, data.payload);
    case "bus": return onBus(JSON.parse(data.payload));
  }
};

// ---------------------------------------------- ovos-visage's GUI socket
// ovos-visage opens WebSocket("/ws") to its own server. Here there is no
// server: the same snapshot-then-deltas stream comes from ovos-gui in the
// worker, so the socket is a stand-in and visage.js runs unmodified.
let ovosReady;
const ready = new Promise((r) => (ovosReady = r));
class GuiSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    guiSockets.add(this);
    ready.then(async () => {
      this.readyState = 1;
      this.deliver(await call("gui_snapshot"));
    });
  }
  deliver(raw) { this.onmessage?.({ data: raw }); }
  send(raw) { call("gui_message", { raw }); }
  close() { guiSockets.delete(this); this.readyState = 3; }
}
const NativeWebSocket = window.WebSocket;
window.WebSocket = new Proxy(NativeWebSocket, {
  construct(target, args) {
    return String(args[0]).endsWith("/ws") ? new GuiSocket() : new target(...args);
  },
});

// ------------------------------------------------------------------ boot
function bootStatus(text, progress) {
  $("boot-text").textContent = text;
  if (progress !== undefined) $("boot-bar").style.width = `${Math.round(progress * 100)}%`;
}

let audioCtx = null;
async function start() {
  $("start").hidden = true;
  audioCtx = new AudioContext();
  await audioCtx.resume();
  if (kiosk) {
    document.documentElement.requestFullscreen?.().catch(() => {});
    screen.orientation?.lock?.("portrait").catch(() => {});
  }
  keepAwake();
  $("boot").hidden = true;
  $("mic").hidden = false;
  $("keyboard").hidden = false;
}

async function keepAwake() {
  try {
    let lock = await navigator.wakeLock?.request("screen");
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") lock = await navigator.wakeLock?.request("screen");
    });
  } catch {}
}

(async () => {
  try {
    const info = await call("boot", { userConfig: null });
    console.log("[emkay] OVOS up", info);
    ovosReady();
    await import("./visage/visage.js");
    bootStatus(`${info.skills.length} skills klar`, 1);
    $("start").hidden = false;
    $("start").onclick = start;
  } catch (e) {
    bootStatus(`Fejl: ${e.message}`);
    console.error(e);
  }
})();

// ------------------------------------------------------------ microphone
// The whole screen is the talk button, like tapping a Mark II. A simple
// energy VAD ends the recording; the STT plugin runs in the worker.
const mic = {
  busy: false,
  async listen() {
    if (this.busy || !audioCtx) return;
    this.busy = true;
    $("mic").className = "mic listening";
    call("record_begin");
    try {
      const pcm = await record();
      $("mic").className = "mic thinking";
      if (pcm) await call("heard", { pcm: pcm.buffer, rate: 16000 }, [pcm.buffer]);
    } catch (e) {
      console.warn("[emkay] mic", e);
    } finally {
      $("mic").className = "mic";
      this.busy = false;
    }
  },
};

let stream = null;
async function record({ maxSeconds = 10, silenceMs = 900, noSpeechMs = 5000 } = {}) {
  stream ??= await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const source = audioCtx.createMediaStreamSource(stream);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let spoke = false, lastLoud = performance.now(), floor = 0.01;
  const t0 = performance.now();
  await new Promise((done) => {
    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(x));
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      const now = performance.now();
      if (now - t0 < 300) floor = Math.max(floor, rms * 1.5);  // room noise
      if (rms > Math.max(0.02, floor * 2)) { spoke = true; lastLoud = now; }
      if ((spoke && now - lastLoud > silenceMs) || (!spoke && now - t0 > noSpeechMs) || now - t0 > maxSeconds * 1000) done();
    };
    source.connect(proc);
    proc.connect(audioCtx.destination);
  });
  proc.disconnect();
  source.disconnect();
  if (!spoke) return null;
  return toPcm16(chunks, audioCtx.sampleRate, 16000);
}

function toPcm16(chunks, from, to) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = from / to, out = new Int16Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

$("screen").addEventListener("click", (e) => {
  if (e.target.closest("button, a, input")) return;
  mic.listen();
});

// --------------------------------------------------------------- speaker
const speaker = {
  queue: [],
  playing: false,
  enqueue(wav, meta) { this.queue.push({ wav, meta }); if (!this.playing) this.next(); },
  async next() {
    const item = this.queue.shift();
    if (!item) { this.playing = false; return; }
    this.playing = true;
    try {
      const buf = await audioCtx.decodeAudioData(item.wav);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.onended = () => { call("playback_ended", { ident: item.meta.ident }); this.next(); };
      src.start();
      call("playback_started", { ident: item.meta.ident, visemes: item.meta.visemes });
    } catch (e) {
      console.warn("[emkay] playback", e);
      call("playback_ended", { ident: item.meta.ident });
      this.next();
    }
  },
};

// ------------------------------------------------------------- bus events
function onBus(msg) {
  if (msg.type === "mycroft.mic.listen") setTimeout(() => mic.listen(), 150);  // a skill asked a question
}

// ---------------------------------------------------------------- typing
$("keyboard").onclick = () => {
  $("type").hidden = !$("type").hidden;
  if (!$("type").hidden) $("type-text").focus();
};
$("type").onsubmit = (e) => {
  e.preventDefault();
  const text = $("type-text").value.trim();
  if (text) call("say", { text });
  $("type-text").value = "";
};

window.emkay = { call, mic, speaker };
