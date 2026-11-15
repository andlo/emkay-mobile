// Emkay – the page side: screen, microphone and speaker.
//
// OVOS itself runs in worker.js. ovos-visage draws the screen, unchanged:
// it thinks it talks to its own server over WebSocket("/ws"), and gets the
// same GUI stream from ovos-gui in the worker instead (GuiSocket below).
//
// URL options: ?kiosk  full screen + portrait lock on start (the installed
// app opens with it, see manifest.webmanifest).

import { t, apply, setLang, onLangChange, matchLang } from "./i18n.js";
import { onRequest as deviceRequest, startDevice } from "./device.js";

const $ = (id) => document.getElementById(id);
apply();                    // the phone's language until OVOS is up
$("boot-text").textContent = t("boot.loading");   // bootStatus' own line from here on
onLangChange(() => { apply(); bootStatus(lastStatus.key, undefined, lastStatus.vars); });
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
    case "status": return bootStatus(data.key, data.progress, data.vars);
    case "gui": for (const s of guiSockets) s.deliver(data.payload); return;
    case "audio": return data.payload.sound ? speaker.playSound(data.data) : speaker.enqueue(data.data, data.payload);
    case "phal": return onPhal(JSON.parse(data.payload));
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
let lastStatus = { key: "boot.loading" };

/** Show boot progress on the start screen; `key` is a text in i18n.js. */
function bootStatus(key, progress, vars) {
  lastStatus = { key, vars };
  $("boot-text").textContent = t(key, vars);
  if (progress !== undefined) $("boot-bar").style.width = `${Math.round(progress * 100)}%`;
}

let audioCtx = null;

/**
 * The first tap. Browsers only allow sound, the microphone and full screen
 * after the user did something, so all of it is switched on here.
 */
async function start() {
  $("start").hidden = true;
  $("first").hidden = true;
  audioCtx = new AudioContext();
  speaker.attach(audioCtx);
  await audioCtx.resume();
  // a phone is the device itself: full screen from the first tap (browsers
  // allow it only after one; the installed app opens full screen anyway)
  if (kiosk || phoneScreen.matches) enterKiosk();
  keepAwake();
  wake.start(bootInfo?.wake_word).catch((e) => { wake.state = `error: ${e.message || e}`; });
  warmingWatch();
  if (bootInfo?.confirm_listening && bootInfo.start_listening_sound) {
    call("sound_bytes", { uri: bootInfo.start_listening_sound })
      .then((bytes) => audioCtx.decodeAudioData(bytes.buffer))
      .then((buf) => { mic.startSound = buf; })
      .catch((e) => console.warn("[emkay] start listening sound", e));
  }
  $("boot").hidden = true;
  for (const id of ["mic", "keyboard", "menu-button"]) $(id).hidden = false;
}

const WELCOMED = "emkay-welcomed";

/**
 * The first time Emkay starts in this browser, offer the control panel's
 * own setup wizard (/setup) next to starting on the defaults. Either
 * choice is remembered; the wizard stays in the ⚙ menu.
 */
function offerSetup() {
  let first = false;
  try { first = !localStorage.getItem(WELCOMED); } catch {}
  const remember = () => { try { localStorage.setItem(WELCOMED, "1"); } catch {} };
  $("start").onclick = () => { remember(); start(); };
  if (!first) return;
  $("start").dataset.i18n = "start.defaults";
  apply();
  $("start").classList.add("quiet");
  $("first").hidden = false;
  $("first-setup").onclick = async () => {
    remember();
    await start();
    openPanel("setup");
  };
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
    $("storage-state").dataset.i18n = kept ? "storage.kept" : "storage.loose";
    apply();
  } catch {
    $("storage-state").textContent = "";
  }
}

(async () => {
  try {
    keepStorage();
    const info = await call("boot", { userConfig: null });
    console.log("[emkay] OVOS up", info);
    setLang(info.lang);   // from here on Emkay's texts follow OVOS' language
    bootInfo = info;
    ovosLang = info.lang || ovosLang;
    sttModule = info.stt_module;
    ovosReady();
    await import("./visage/visage.js");
    bootStatus("boot.skills", 1, { n: info.skills.length });
    offerSetup();
    startDevice(call);   // the phone's sensors and connectivity, for PHAL
    $("start").hidden = false;
  } catch (e) {
    bootStatus("boot.error", undefined, { msg: e.message });
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
  muted: false,   // the listener was muted (mycroft.mic.mute), e.g. from the panel
  /** Follow the listener's mute state; a muted mic shows as such. */
  setMuted(muted) {
    this.muted = muted;
    $("mic").classList.toggle("muted", muted);
  },
  async listen() {
    if (this.busy || this.muted || !audioCtx) return;
    this.busy = true;
    questionsAsked++;
    $("mic").className = "mic listening";
    caption(t("mic.listening"), 0);
    // OVOS' confirm-listening sound, before the recording (so it is not in it)
    if (bootInfo?.confirm_listening && this.startSound) await speaker.playSound(this.startSound);
    call("record_begin");
    try {
      if (sttModule === BROWSER_STT && SpeechRecognitionAPI) {
        // the browser's recognition wants the microphone to itself: an open
        // stream of ours makes it fail ("audio-capture") on some devices
        releaseMic();
        const text = await browserSTT();
        wake.attach().catch(() => {});
        $("mic").className = "mic thinking";
        if (!text) caption(t("mic.nothing"), null, 4000);
        else {
          caption(`“${text}”`, null, 6000);
          const before = speaker.spoken, handled = utterancesHandled;
          if (await call("heard_text", { text })) unanswered(before, handled);
        }
        return;
      }
      const l = bootInfo?.listener || {};
      const pcm = await record({
        level: (v) => caption(t("mic.listening"), v),
        silenceMs: (l.silence_end ?? 0.7) * 1000,
        maxSeconds: l.recording_timeout ?? 10,
        noSpeechMs: (l.recording_timeout_with_silence ?? 3) * 1000,
      });
      $("mic").className = "mic thinking";
      if (!pcm) {
        caption(t("mic.nothing"), null, 4000);
      } else {
        caption(t("mic.thinking"));
        const before = speaker.spoken, handled = utterancesHandled;
        const text = await call("heard", { pcm: pcm.buffer, rate: 16000 }, [pcm.buffer]);
        caption(text ? `“${text}”` : t("mic.unclear"), null, text ? 6000 : 4000);
        if (text) unanswered(before, handled);
      }
    } catch (e) {
      console.warn("[emkay] mic", e);
      caption(t("mic.error", { msg: e.message || String(e) }), null, 6000);
    } finally {
      $("mic").className = this.muted ? "mic muted" : "mic";
      this.busy = false;
    }
  },
};

let stream = null;
let captionTimer = null;
let questionsAsked = 0;   // typed or spoken; ends the warm-up note
let utterancesHandled = 0;   // ovos.utterance.handled seen (unanswered() waits for one)

/**
 * A question was handled and nothing was said: a skill or fallback that
 * failed quietly, often because its service cannot be reached from a
 * browser (issue #6). Instead of silence: OVOS' error sound (sounds.error,
 * as the listener plays it) and a line under the face. `before` is
 * speaker.spoken when the question went in. The question is done when
 * OVOS says so (ovos.utterance.handled; the worker may hand the question
 * over and return before that, JSPI #20), and speech may follow by a moment,
 * so it waits for both.
 */
async function unanswered(before, handledBefore = utterancesHandled - 1) {
  for (let i = 0; i < 1200 && utterancesHandled <= handledBefore; i++) {
    await new Promise((r) => setTimeout(r, 100));   // at most 2 minutes
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (speaker.spoken !== before || speaker.playing) return;
  caption(t("noanswer"), null, 6000);
  if (!mic.errorSound && bootInfo?.error_sound) {
    try {
      mic.errorSound = await audioCtx.decodeAudioData((await call("sound_bytes", { uri: bootInfo.error_sound })).buffer);
    } catch { mic.errorSound = null; }
  }
  if (mic.errorSound) speaker.playSound(mic.errorSound);
}

/**
 * Right after start OVOS still prepares its intent matching in the
 * background (padatious' padaos compiles its regexes: half a minute or more
 * in WebAssembly). A question asked meanwhile is answered when that is
 * done; until then the caption says "Warming up…", so silence is not
 * mistaken for not listening. The worker is pinged for the first minutes;
 * a slow answer means it is still busy.
 */
async function warmingWatch(seconds = 150) {
  const end = performance.now() + seconds * 1000;
  const asked = () => speaker.spoken > 0 || mic.busy || questionsAsked > 0;
  let shown = false, wasSlow = false;
  while (performance.now() < end && !asked()) {
    const slow = setTimeout(() => {
      wasSlow = true;
      if (!asked() && $("caption").hidden) { caption(t("warming")); shown = true; }
    }, 700);
    const t0 = performance.now();
    await call("python", { code: "1" }).catch(() => {});
    clearTimeout(slow);
    const fast = performance.now() - t0 < 300;
    if (shown && fast) { caption(t("warming"), null, 1); shown = false; }
    if (wasSlow && fast) return;   // the warm-up is over
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (shown) caption(t("warming"), null, 1);
}

// ovos-stt-plugin-browser: the browser's own speech recognition, chosen as
// OVOS' STT plugin (stt.module). Kept up to date from boot and config changes.
const BROWSER_STT = "ovos-stt-plugin-browser";
const SpeechRecognitionAPI = self.SpeechRecognition || self.webkitSpeechRecognition;
let sttModule = null;
let ovosLang = "en-US";

/**
 * One utterance with the browser's recognition, in OVOS' language. The
 * words show in the caption as they come; resolves with the final text
 * ("" when nothing was said). Times out after 12 s like a recording.
 */
function browserSTT() {
  return new Promise((resolve) => {
    const r = new SpeechRecognitionAPI();
    r.lang = ovosLang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let final = "", done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(final.trim()); } };
    const timer = setTimeout(() => { try { r.stop(); } catch {} }, 12000);
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      caption(final + interim || t("mic.listening"), 0.3);
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") caption(t("mic.error", { msg: e.error }), null, 6000);
    };
    r.onend = finish;
    try { r.start(); } catch (e) { caption(t("mic.error", { msg: e.message }), null, 6000); finish(); }
  });
}

/** Let the microphone go (the browser's own recognition needs it); the
 * next micStream() opens it again. */
function releaseMic() {
  wake.detach();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}

/**
 * The microphone, opened once (the first tap) and kept. Echo cancellation
 * stays on, so Emkay does not hear itself; the browser's noise suppression
 * and automatic gain are off: they distort speech (the gain clips it) and
 * the wake word model is trained on plain audio, as STT servers expect it.
 */
async function micStream() {
  stream ??= await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });
  return stream;
}

/**
 * The wake word: OVOS' `listener.wake_word` ("hey_mycroft" by default),
 * heard by openWakeWord in its own worker (wakeword.js). The microphone
 * stays open while Emkay is on screen; what it hears is passed on in 80 ms
 * chunks of 16 kHz audio, except while Emkay records, speaks or is muted.
 * Hearing it does what ovos-dinkum-listener does: tell OVOS
 * (recognizer_loop:wakeword) and listen for the question.
 */
const wake = {
  worker: null,
  state: "off",   // for diagnostics: off (and why), loading, listening, error: ...
  chunks: 0,      // 80 ms chunks passed on, and the best score seen (diagnostics)
  best: 0,
  async start(name) {
    if (!name) { this.state = "off: no listener.wake_word"; return; }
    if (!(bootInfo?.wake_words || []).includes(name)) { this.state = `off: no model for ${name}`; return; }
    this.state = "loading";
    const model = `${name}_v0.1.onnx`;
    this.worker = new Worker("wakeword.js", { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data.error) { this.state = `error: ${data.error}`; console.warn("[emkay] wake word:", data.error); }
      if (data.ready) { this.state = "listening"; $("mic").classList.add("wake"); }
      if (data.score) this.best = Math.max(this.best, data.score);
      if (data.detected && this.active()) this.heard(name);
    };
    this.worker.postMessage({ cmd: "start", model });
    // to 16 kHz Int16 by averaging (as toPcm16), 1280 samples at a time
    const ratio = audioCtx.sampleRate / 16000;
    const chunk = new Int16Array(1280);
    let fill = 0, acc = 0, n = 0, due = ratio;
    const proc = audioCtx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => {
      if (!this.active()) { fill = 0; return; }
      const x = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < x.length; i++) {
        acc += x[i]; n++;
        if (n >= due) {
          const v = Math.max(-1, Math.min(1, acc / n));
          chunk[fill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
          acc = 0; due += ratio - n; n = 0;
          if (fill === chunk.length) {
            this.worker.postMessage({ cmd: "audio", pcm: chunk.slice() });
            this.chunks++;
            fill = 0;
          }
        }
      }
    };
    proc.connect(audioCtx.destination);   // a ScriptProcessor runs only when connected; it outputs silence
    this.proc = proc;
    await this.attach();
  },
  /** Feed the microphone in (again, after the browser's recognition had it). */
  async attach() {
    if (!this.proc || this.source) return;
    this.source = audioCtx.createMediaStreamSource(await micStream());
    this.source.connect(this.proc);
  },
  detach() {
    this.source?.disconnect();
    this.source = null;
  },
  /** Listening for the wake word now? Not while recording, speaking, muted or hidden. */
  active() {
    return !mic.busy && !mic.muted && !speaker.playing && document.visibilityState === "visible";
  },
  heard(name) {
    call("wakeword", { name });
    mic.listen();
  },
};

/**
 * The line under the face: what the microphone is doing and what it heard,
 * so a question that gets no answer shows where it stopped.
 * @param {string} text
 * @param {number|null} level  0..1 for the level bar while listening
 * @param {number} hideAfter   ms until the line goes, 0 = stays
 */
function caption(text, level = null, hideAfter = 0) {
  const el = $("caption");
  el.hidden = false;
  $("caption-text").textContent = text;
  $("caption-level").hidden = level === null;
  if (level !== null) $("caption-level").firstChild.style.width = `${Math.round(Math.min(1, level) * 100)}%`;
  clearTimeout(captionTimer);
  if (hideAfter) captionTimer = setTimeout(() => (el.hidden = true), hideAfter);
}

/**
 * Record one utterance from the microphone.
 * Starts at once; stops after `silenceMs` of quiet once speech was heard,
 * after `noSpeechMs` with no speech at all, or after `maxSeconds`.
 * @returns {Promise<Uint8Array|null>} 16 kHz mono 16-bit PCM, or null if
 *   nothing was said
 */
async function record({ maxSeconds = 10, silenceMs = 700, noSpeechMs = 3000, level } = {}) {
  const source = audioCtx.createMediaStreamSource(await micStream());
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  // Speech is what stands out from the room. The room is measured in the
  // first 300 ms by its *quietest* blocks, so speaking right away does not
  // raise the bar; phones turn the level down (noise suppression, gain
  // control), so the bar itself is low.
  let spoke = false, lastLoud = performance.now(), floor = Infinity;
  const t0 = performance.now();
  await new Promise((done) => {
    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(x));
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      const now = performance.now();
      if (now - t0 < 300) floor = Math.min(floor, rms);           // room noise
      const bar = Math.max(0.006, Math.min(0.03, (floor === Infinity ? 0 : floor) * 3));
      if (now - t0 >= 150 && rms > bar) { spoke = true; lastLoud = now; }
      level?.(Math.sqrt(rms / 0.1));                                 // for the eye only
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
 *
 * Everything goes through one gain node: the "mixer" of the browser PHAL
 * plugin (py/emkay_mobile/phal.py), which answers OVOS' mycroft.volume.*
 * messages and sends the level here.
 */
const speaker = {
  queue: [],
  playing: false,
  level: { volume: 0.75, muted: false },
  gain: null,
  /** Create the output gain once the AudioContext exists. */
  attach(ctx) {
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.setVolume(this.level);
  },
  /** Apply {volume: 0..1, muted} from the PHAL plugin. */
  setVolume(level) {
    this.level = level;
    if (this.gain) this.gain.gain.value = level.muted ? 0 : level.volume;
  },
  spoken: 0,   // answers queued so far (unanswered() compares)
  enqueue(wav, meta) { this.spoken++; this.queue.push({ wav, meta }); if (!this.playing) this.next(); },
  /**
   * A sound (ovos-audio's play_sound): played at once, over speech, through
   * the same volume. Resolves when it has finished.
   */
  async playSound(data) {
    if (!audioCtx) return;
    try {
      const buf = data instanceof AudioBuffer ? data : await audioCtx.decodeAudioData(data);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain || audioCtx.destination);
      await new Promise((ok) => { src.onended = ok; src.start(); });
    } catch (e) {
      console.warn("[emkay] sound", e);
    }
  },
  async next() {
    const item = this.queue.shift();
    if (!item) { this.playing = false; return; }
    if (!audioCtx) {
      // nothing may sound before the first tap (browser rule): skip it, but
      // tell OVOS it is done, so its speech state does not hang
      call("playback_ended", { ident: item.meta.ident });
      return this.next();
    }
    this.playing = true;
    try {
      const buf = await audioCtx.decodeAudioData(item.wav);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain || audioCtx.destination);
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

// ------------------------------------------------------------ PHAL plugin
/**
 * A message from the browser PHAL plugin (py/emkay_mobile/phal.py), which
 * answers OVOS' hardware messages: a volume level to apply, or a request
 * for something only the page can reach.
 */
function onPhal(msg) {
  if (msg.request === "location") return locate();
  if (deviceRequest(msg)) return;   // power, camera (device.js)
  speaker.setVolume(msg);
}

/**
 * The phone's position for OVOS' location (the plugin turns it into city,
 * country and time zone). The browser asks the user first; a "no" leaves
 * OVOS on the browser's time zone.
 */
function locate() {
  const answer = (args) => call("phal_position", args);
  if (!navigator.geolocation) return answer({ error: "geolocation unsupported" });
  navigator.geolocation.getCurrentPosition(
    (p) => answer({ lat: p.coords.latitude, lon: p.coords.longitude }),
    (e) => answer({ error: e.message || `code ${e.code}` }),
    { maximumAge: 3600e3, timeout: 60e3 },
  );
}

// ------------------------------------------------------------- bus events
/** React to the few bus events the page itself cares about. */
function onBus(msg) {
  if (msg.type === "mycroft.mic.listen") setTimeout(() => mic.listen(), 150);  // a skill asked a question
  if (msg.type === "ovos.utterance.handled") utterancesHandled++;
  if (msg.type === "mycroft.mic.mute") mic.setMuted(true);
  if (msg.type === "emkay.lang") {   // a config change, e.g. in the panel
    languageChanged(msg.data.lang);
    ovosLang = msg.data.lang || ovosLang;
    sttModule = msg.data.stt_module ?? sttModule;
  }
  if (msg.type === "mycroft.mic.unmute") mic.setMuted(false);
}

// ---------------------------------------------------------------- typing
$("keyboard").onclick = () => {
  $("type").hidden = !$("type").hidden;
  if (!$("type").hidden) $("type-text").focus();
};
$("type").onsubmit = (e) => {
  e.preventDefault();
  const text = $("type-text").value.trim();
  if (text) {
    const before = speaker.spoken, handled = utterancesHandled;
    questionsAsked++;
    call("say", { text }).then(() => unanswered(before, handled));
  }
  $("type-text").value = "";
};

// -------------------------------------------------------- settings panel
// The stock ovos-control-panel runs in the worker (py/emkay_mobile/panel.py).
// sw.js catches the requests its pages make and hands each one here, with
// a port for the answer; the worker's panel app produces the response.

/**
 * The panel's cookies. Once an access token is set, the panel signs a
 * browser in with a cookie (ovos_webui_token). A response a Service Worker
 * builds may not set cookies (the browser drops Set-Cookie), so this page
 * keeps them, as a browser would, and sends them with each panel request.
 * They live as long as this page (and OVOS) does; after a reload the panel
 * asks for the token again.
 */
const panelCookies = new Map();

/** The request's headers with the kept cookies. */
function withCookies(headers) {
  const out = headers.filter(([k]) => k.toLowerCase() !== "cookie");
  if (panelCookies.size) out.push(["cookie", [...panelCookies].map(([k, v]) => `${k}=${v}`).join("; ")]);
  return out;
}

/** Keep, replace or drop cookies from a response's Set-Cookie headers. */
function keepCookies(headers) {
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== "set-cookie") continue;
    const [pair, ...attrs] = v.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim().replace(/^"|"$/g, "");
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a))
      || attrs.some((a) => { const m = a.match(/^\s*expires\s*=(.*)$/i); return m && Date.parse(m[1]) < Date.now(); });
    if (!value || expired) panelCookies.delete(name);
    else panelCookies.set(name, value);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("[emkay] service worker", e));
  navigator.serviceWorker.onmessage = async (event) => {
    const req = event.data?.panelRequest;
    const port = event.ports[0];
    if (!req || !port) return;
    try {
      await ready;   // OVOS (and so the panel) is up
      req.headers = withCookies(req.headers);
      const res = await call("panel_request", req, req.body ? [req.body] : []);
      keepCookies(res.headers);
      port.postMessage(res, [res.body.buffer]);
    } catch (e) {
      const body = new TextEncoder().encode(String(e));
      port.postMessage({ status: 502, headers: [["content-type", "text/plain"]], body }, [body.buffer]);
    }
  };
}

let bootInfo = null;   // what boot() returned

/**
 * OVOS' language changed (the control panel). Emkay's texts follow at once.
 * The pre-trained intents for a language are fetched when OVOS starts, as
 * a device loads a new language when its services restart; so if this
 * boot has none for the new one, a button offers that restart.
 */
function languageChanged(lang) {
  setLang(lang);
  const want = matchLang(lang, bootInfo?.site_langs || []);
  const missing = Boolean(want) && !(bootInfo?.intent_langs || []).includes(want);
  const el = $("restart-lang");
  el.hidden = !missing;
  if (missing) {
    el.textContent = t("restart.lang", { lang: want });
    el.onclick = async () => { await call("sync").catch(() => {}); location.reload(); };
  }
}

/**
 * Show the OpenVoiceOS settings over the face.
 * @param {string} page  a panel page to open, e.g. "setup"; "" keeps the
 *   page that was open last (the dashboard the first time)
 */
function openPanel(page = "") {
  $("menu").hidden = true;
  // the panel's own Simple view (only the everyday pages) to begin with, on
  // a phone; its header toggle shows all pages and is remembered from then
  // on (localStorage "ovos-simple" is the panel's own setting, same origin)
  try {
    if (localStorage.getItem("ovos-simple") === null) localStorage.setItem("ovos-simple", "1");
  } catch {}
  const frame = $("panel-frame");
  if (page || !frame.getAttribute("src")) frame.src = `panel/${page}`;
  $("panel").hidden = false;
}
$("panel-close").onclick = () => { $("panel").hidden = true; };

// ------------------------------------------------------------------ menu
$("menu-panel").onclick = () => openPanel();
$("menu-button").onclick = () => { $("menu").hidden = !$("menu").hidden; };
$("menu-close").onclick = () => { $("menu").hidden = true; };
$("menu-kiosk").onclick = () => { kiosk = true; enterKiosk(); $("menu").hidden = true; };

// ------------------------------------------------------- install as an app
// Chrome, Edge and Android offer installing a site with a manifest
// (manifest.webmanifest: full screen, the face's icon) and fire
// beforeinstallprompt; the menu then has "Install as app", which asks the
// browser to show its own install dialog. iOS has no such event: Safari
// installs from Share → "Add to Home Screen", so the menu says that. Once
// Emkay runs as an installed app, neither shows.
const installed = () => matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches
  || navigator.standalone === true;
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();          // no mini-infobar: the menu offers it
  installPrompt = e;
  $("menu-install").hidden = installed();
});
addEventListener("appinstalled", () => { installPrompt = null; $("menu-install").hidden = true; });
$("menu-install").onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $("menu-install").hidden = true;
  $("menu").hidden = true;
};
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !installed()) $("install-ios").hidden = false;

/** About: who made Emkay and what it stands on; the build date from build.json. */
$("menu-about").onclick = async () => {
  $("menu").hidden = true;
  $("about").hidden = false;
  try {
    const built = (await (await fetch("build.json")).json()).built;
    $("about-version").textContent = t("about.version", { date: new Date(built).toLocaleDateString() });
  } catch { $("about-version").textContent = ""; }
};
$("about-close").onclick = () => { $("about").hidden = true; };

window.emkay = { call, mic, speaker, wake, stt: () => sttModule };
