// Emkay Mobile – the page side: screen, microphone and speaker.
//
// OVOS itself runs in worker.js. ovos-visage draws the screen, unchanged:
// it thinks it talks to its own server over WebSocket("/ws"), and gets the
// same GUI stream from ovos-gui in the worker instead (GuiSocket below).
//
// URL options: ?kiosk  full screen + portrait lock on start (the installed
// app opens with it, see manifest.webmanifest).

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let kiosk = params.has("kiosk");

// ---------------------------------------------------------------- layout
// On a large screen visage draws the whole Mark II and scales it to the
// window. On a phone the phone *is* the device: html.fullscreen hides the
// drawing (emkay.css) and the 480 px wide Mark II screen gets the phone's
// own aspect ratio, so visage's scaling makes it fill the display. This
// listener is registered before visage's own resize handler (visage.js is
// imported later), so visage always measures the new size.
const phoneScreen = matchMedia("(max-width: 700px), (pointer: coarse) and (max-width: 1100px)");

/** Size the screen for this window: full screen on phones, the device elsewhere. */
function layout() {
  const root = document.documentElement;
  const full = phoneScreen.matches;
  root.classList.toggle("fullscreen", full);
  if (full) {
    // the Mark II screen is 480 x 800; never shorter than 640 (landscape)
    const h = Math.max(640, Math.round(480 * innerHeight / innerWidth));
    root.style.setProperty("--screen-h", `${h}px`);
  } else {
    root.style.removeProperty("--screen-h");
  }
}
layout();
addEventListener("resize", layout);

// ---------------------------------------------------------------- worker
const worker = new Worker("worker.js", { type: "module" });
let nextId = 1;
const waiting = new Map();

/**
 * Ask the worker to run a command; resolves with its result.
 * @param {string} cmd one of worker.js `commands`
 * @param {object} args the command's arguments
 * @param {Transferable[]} transfer buffers to move instead of copy
 */
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
let ovosReady;
const ready = new Promise((r) => (ovosReady = r));

/**
 * Stands in for the WebSocket ovos-visage opens to its server: on "open"
 * it delivers ovos-gui's snapshot, then every GUI message as it comes.
 */
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
  /** One GUI message (JSON text) for visage. */
  deliver(raw) { this.onmessage?.({ data: raw }); }
  /** A message from visage (page focus, events) for ovos-gui. */
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
/** Show boot progress on the start screen. */
function bootStatus(text, progress) {
  $("boot-text").textContent = text;
  if (progress !== undefined) $("boot-bar").style.width = `${Math.round(progress * 100)}%`;
}

let audioCtx = null;

/**
 * The first tap. Browsers only allow sound, the microphone and full screen
 * after the user did something, so all of it is switched on here.
 */
async function start() {
  $("start").hidden = true;
  audioCtx = new AudioContext();
  await audioCtx.resume();
  if (kiosk) enterKiosk();
  keepAwake();
  $("boot").hidden = true;
  for (const id of ["mic", "keyboard", "menu-button"]) $(id).hidden = false;
}

/** Full screen and portrait, like a device on the shelf. */
function enterKiosk() {
  document.documentElement.requestFullscreen?.().catch(() => {});
  screen.orientation?.lock?.("portrait").catch(() => {});
}

/** Keep the screen on while the page is visible (Screen Wake Lock API). */
async function keepAwake() {
  try {
    await navigator.wakeLock?.request("screen");
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") await navigator.wakeLock?.request("screen");
    });
  } catch {}
}

/**
 * Ask the browser to keep this site's storage (settings, downloads) even
 * when the phone runs low on space. Browsers grant it to installed apps
 * and to sites used often; the answer is shown in the menu.
 */
async function keepStorage() {
  try {
    const kept = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.());
    $("storage-state").textContent = kept
      ? "Gemt varigt på telefonen"
      : "Kan ryddes af browseren – gem en kopi";
  } catch {
    $("storage-state").textContent = "";
  }
}

(async () => {
  try {
    keepStorage();
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
/**
 * Tap-to-talk. The whole screen is the button, like tapping a Mark II.
 * A simple energy VAD ends the recording; the STT plugin runs in the worker.
 */
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

/**
 * Record one utterance from the microphone.
 * Starts at once; stops after `silenceMs` of quiet once speech was heard,
 * after `noSpeechMs` with no speech at all, or after `maxSeconds`.
 * @returns {Promise<Uint8Array|null>} 16 kHz mono 16-bit PCM, or null if
 *   nothing was said
 */
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

/** Float32 chunks at `from` Hz -> one 16-bit PCM buffer at `to` Hz. */
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
/**
 * Plays the WAVs the TTS plugin makes, one after another, and tells OVOS
 * when each starts and ends (that is what moves the face's mouth).
 */
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
/** React to the few bus events the page itself cares about. */
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

// ------------------------------------------------------------------ menu
$("menu-button").onclick = () => { $("menu").hidden = !$("menu").hidden; };
$("menu-close").onclick = () => { $("menu").hidden = true; };
$("menu-kiosk").onclick = () => { kiosk = true; enterKiosk(); $("menu").hidden = true; };

/** Save the settings as a file on the phone (Downloads). */
$("menu-export").onclick = async () => {
  try {
    const zip = await call("export_settings");
    const name = `emkay-indstillinger-${new Date().toISOString().slice(0, 10)}.zip`;
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([zip], { type: "application/zip" })),
      download: name,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $("menu-note").textContent = `Gemt som ${name}`;
  } catch (e) {
    $("menu-note").textContent = `Kunne ikke gemme: ${e.message}`;
  }
};

/** Restore settings from a file saved earlier, then restart OVOS. */
$("menu-import").onclick = () => $("import-file").click();
$("import-file").onchange = async () => {
  const file = $("import-file").files[0];
  if (!file) return;
  try {
    const data = await file.arrayBuffer();
    const manifest = await call("import_settings", { data }, [data]);
    $("menu-note").textContent = `Hentet (${manifest.files} filer fra ${manifest.exported}). Genstarter…`;
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    $("menu-note").textContent = `Kunne ikke hente: ${e.message}`;
  }
};

window.emkay = { call, mic, speaker };
