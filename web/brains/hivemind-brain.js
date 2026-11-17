// Emkay – the HiveMind brain (issue #11): Emkay as a satellite of an
// OpenVoiceOS in the house. The phone keeps the body – face, wake word,
// microphone, speaker – and the questions go to a hivemind-core over
// web/brains/hivemind.js. Nothing heavy loads: no Pyodide, no OVOS here.
//
// Like hivemind-voice-sat: wake word and speech recognition on the phone
// (whisper.js, or the browser's own recognition), only the text goes to
// the house; `speak` comes back and the phone makes the voice (piper.js).
//
// app.js talks to a brain through the worker's commands (call(cmd)); this
// brain answers the ones a satellite has – heard, say, record_begin,
// playback_* … – and quietly declines the rest (the control panel, the
// skill store and the network log belong to the local brain).
//
// Settings live in localStorage ("emkay-hivemind"): host, port, ssl, key,
// password, lang, stt ("whisper" | "browser"). They can be handed over once
// in the address, after "#hivemind=" as base64 JSON – a fragment never
// leaves the browser – e.g. from a QR code; Emkay saves them and drops the
// fragment from the address.

import { HiveMindClient } from "./hivemind.js";
import { t } from "../i18n.js";
import { setBrain } from "./saved.js";

const KEY = "emkay-hivemind";
const BROWSER_STT = "ovos-stt-plugin-browser";
const WHISPER_STT = "ovos-stt-plugin-whisper-browser";

/** As ovos-tts-plugin-piper-browser's VOICES and ovos-stt-plugin-whisper-browser's MODELS. */
const VOICES = {
  "en-us": "en_US-lessac-medium", "en-gb": "en_GB-alba-medium", "da-dk": "da_DK-talesyntese-medium",
  "de-de": "de_DE-thorsten-medium", "es-es": "es_ES-davefx-medium", "fr-fr": "fr_FR-siwis-medium",
  "it-it": "it_IT-paola-medium", "nl-nl": "nl_NL-pim-medium", "pt-pt": "pt_PT-tugão-medium",
  "pt-br": "pt_BR-faber-medium", "ca-es": "ca_ES-upc_ona-medium", "eu-es": "eu_ES-antton-medium",
};
export const voiceFor = (lang) => VOICES[lang.toLowerCase()]
  || Object.entries(VOICES).find(([k]) => k.split("-")[0] === lang.split("-")[0].toLowerCase())?.[1];
const STT_MODELS = { en: "onnx-community/whisper-base.en", da: "emkay-voice/roest-wav2vec2-315m-onnx" };
export const sttModelFor = (lang) => STT_MODELS[lang.split("-")[0].toLowerCase()] || "onnx-community/whisper-base";

/**
 * The mouth: visemes from the text, spread evenly over the audio – as
 * py/emkay_mobile/speech.py text_visemes does for a TTS without phonemes.
 * [[code, end seconds], …], the form enclosure.mouth.viseme_list carries.
 */
const VISEME_OF = [[/[bpm]/, "4"], [/[fv]/, "5"], [/[ouw]/, "2"], [/[aei]/, "0"], [/[a-z]/, "3"]];
export function textVisemes(text, seconds) {
  const letters = [...String(text).toLowerCase()].filter((c) => /\p{L}/u.test(c) || " ,.!?".includes(c));
  if (!letters.length || seconds <= 0) return [];
  const step = seconds / letters.length, out = [];
  let t = 0;
  for (const c of letters) {
    t += step;
    const code = VISEME_OF.find(([re]) => re.test(c))?.[1] ?? "4";
    if (out.length && out.at(-1)[0] === code) out.at(-1)[1] = +t.toFixed(3);
    else out.push([code, +t.toFixed(3)]);
  }
  return out;
}

/** Seconds of a 16-bit PCM WAV (as piper.js makes them). */
export function wavSeconds(wav) {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const byteRate = v.getUint32(28, true), dataBytes = v.getUint32(40, true);
  return byteRate ? dataBytes / byteRate : 0;
}

/** Settings from the address (once) or localStorage; null when there are none. */
export function hivemindSettings() {
  const m = location.hash.match(/[#&]hivemind=([^&]+)/);
  if (m) {
    try {
      const s = JSON.parse(atob(decodeURIComponent(m[1])));
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) { console.warn("[emkay] #hivemind= could not be read", e); }
    history.replaceState(null, "", location.pathname + location.search);
  }
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
}

export function saveHivemindSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

/**
 * Ask for the connection (host, port, wss, key, password) in a small form
 * over the boot screen; resolves with the settings when "Connect" is
 * pressed. `back`: a Back button, which resolves null. `local`: a "use
 * Emkay on this device instead" button, which switches to the local brain –
 * so a house that can't be reached never locks Emkay out.
 */
export function askHivemindSettings(prev = {}, error = "", { back = false, local = false } = {}) {
  return new Promise((resolve) => {
    document.getElementById("hivemind-setup")?.remove();
    const form = document.createElement("form");
    form.id = "hivemind-setup";
    form.className = "hivemind-setup";
    const field = (name, type, value, extra = "") =>
      `<label>${t(`hivemind.${name}`)}<input name="${name}" type="${type}" value="${value ?? ""}" ${extra}></label>`;
    form.innerHTML = `
      <h2>${t("hivemind.title")}</h2>
      <p>${t("hivemind.hint")}</p>
      ${error ? `<p class="error"></p>` : ""}
      ${field("host", "text", prev.host, 'required autocapitalize="off" spellcheck="false"')}
      ${field("port", "number", prev.port ?? 5678, 'required min="1" max="65535"')}
      <label class="check"><input name="ssl" type="checkbox" ${prev.ssl ?? location.protocol === "https:" ? "checked" : ""}> ${t("hivemind.ssl")}</label>
      ${field("key", "text", prev.key, 'required autocapitalize="off" spellcheck="false"')}
      ${field("password", "password", prev.password, "required")}
      <button type="submit">${t("hivemind.connect")}</button>
      ${back ? `<button type="button" class="secondary" data-act="back">${t("hivemind.back")}</button>` : ""}
      ${local ? `<button type="button" class="secondary" data-act="local">${t("hivemind.use_local")}</button>` : ""}`;
    if (error) form.querySelector(".error").textContent = error;   // text, not HTML
    form.querySelector('[data-act="back"]')?.addEventListener("click", () => { form.remove(); resolve(null); });
    form.querySelector('[data-act="local"]')?.addEventListener("click", () => {
      setBrain("local");
      location.replace(location.pathname);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(form);
      form.remove();
      resolve({ ...prev, host: f.get("host").trim(), port: +f.get("port"), ssl: f.has("ssl"),
                key: f.get("key").trim(), password: f.get("password") });
    };
    document.body.append(form);
  });
}

/**
 * @param {object} [opts]
 * @param {(s: object, error: string) => Promise<object>} [opts.ask]  how to ask for settings
 * @returns {import("./brain.js").Brain}
 */
export function createHiveMindBrain({ ask = askHivemindSettings } = {}) {
  const handlers = new Map();
  const busListeners = new Set();
  const fire = (kind, data) => { for (const fn of handlers.get(kind) || []) fn(data); };
  /** A bus message to the page: the visage (core) and app.js' onBus (bus). */
  const local = (type, data = {}, context = {}) => {
    const raw = JSON.stringify({ type, data, context });
    for (const fn of busListeners) fn(raw);
    fire("bus", { payload: raw });
  };
  globalThis.emkayModelProgress = (what, name, progress, state = "loading") =>
    fire("model", { payload: { what, name, progress, state } });

  let client = null;
  let settings = null;
  let lang = "en-US";
  let nextIdent = 1;

  async function connect() {
    settings = hivemindSettings();
    let error = "";
    for (;;) {
      if (!settings?.host || !settings?.key || !settings?.password) settings = await ask(settings || {}, error, { local: true });
      fire("status", { key: "hivemind.connecting", vars: { host: settings.host } });
      lang = settings.lang || navigator.language || "en-US";
      client = new HiveMindClient({ ...settings, lang, siteId: settings.siteId || "emkay" });
      try {
        await client.connect();
        saveHivemindSettings(settings);
        break;
      } catch (e) {
        console.warn("[emkay] hivemind", e);
        // in the page's language where we know the error, else as it came
        error = e.code ? t(`hivemind.err.${e.code}`, { host: settings.host }) : (e.message || String(e));
        if (location.protocol === "https:" && !settings.ssl) error += ` – ${t("hivemind.needs_wss")}`;
        settings = { ...settings, password: "" };   // ask again, with what was typed
      }
    }
    client.addEventListener("message", (e) => fromHive(e.message));
    client.addEventListener("close", () => {
      fire("status", { key: "hivemind.lost", vars: { host: settings.host } });
      setTimeout(() => reconnect(), 3000);
    });
  }

  async function reconnect() {
    try {
      client = new HiveMindClient({ ...settings, lang, siteId: settings.siteId || "emkay" });
      await client.connect();
      client.addEventListener("message", (e) => fromHive(e.message));
      client.addEventListener("close", () => setTimeout(() => reconnect(), 3000));
      fire("status", { key: "hivemind.connected", progress: 1, vars: { node: client.nodeId } });
    } catch {
      setTimeout(() => reconnect(), 10000);
    }
  }

  /** What the house says. */
  async function fromHive(msg) {
    const raw = JSON.stringify(msg);
    for (const fn of busListeners) fn(raw);
    fire("bus", { payload: raw });
    if (msg.type === "speak" && msg.data?.utterance) speak(msg.data.utterance, msg.data.lang || lang);
  }

  /** The voice, on the phone (piper.js); the page plays it. */
  async function speak(text, l) {
    const voice = voiceFor(l) || voiceFor(lang);
    if (!voice) return console.warn(`[emkay] no Piper voice for ${l}`);
    try {
      const piper = await import("../piper.js");
      const wav = await piper.synth(text, voice);
      const visemes = textVisemes(text, wavSeconds(wav));
      fire("audio", { payload: { ident: `hm-${nextIdent++}`, utterance: text, visemes }, data: wav.buffer });
    } catch (e) {
      console.warn("[emkay] speak", e);
    }
  }

  /** A question for the house. */
  async function ask_(text) {
    await client.emit("recognizer_loop:utterance", { utterances: [text], lang });
    return true;
  }

  const commands = {
    async boot() {
      fire("status", { key: "boot.loading" });
      await connect();
      fire("status", { key: "hivemind.connected", progress: 1, vars: { node: client.nodeId } });
      const build = await fetch("build.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({}));
      const precise = build.precise_models || {};
      const heyMycroft = Object.keys(precise).find((u) => /hey_mycroft/.test(u));
      // Emkay's own "hey M K" where the site has it, as the local brain
      // (boot.py EMKAY_WAKE_WORD, defaults v13); "hey mycroft" otherwise;
      // settings.wakeWord picks another of the site's wake words
      const wakeWords = build.wake_words || [];
      const wakeWord = (settings.wakeWord && wakeWords.includes(settings.wakeWord) && settings.wakeWord)
        || (wakeWords.includes("hey_emkay") ? "hey_emkay" : "hey_mycroft");
      const hotword = wakeWord === "hey_mycroft" && heyMycroft
        ? { module: "ovos-ww-plugin-precise-onnx", model: heyMycroft }
        : { module: "ovos-ww-plugin-openwakeword", threshold: wakeWord === "hey_emkay" ? 0.8 : 0.5 };
      const stt = settings.stt === "browser" ? BROWSER_STT : WHISPER_STT;
      if (stt === WHISPER_STT) import("../whisper.js").then((w) => w.ready(sttModelFor(lang))).catch(() => {});
      const voice = voiceFor(lang);
      if (voice) import("../piper.js").then((p) => p.ready(voice)).catch(() => {});
      return {
        brain: "hivemind", node: client.nodeId, lang, skills: [], stt_module: stt,
        wake_word: wakeWord, hotword,
        precise_models: precise, wake_words: wakeWords,
        site_langs: [lang], intent_langs: [lang], listener: {}, confirm_listening: false,
      };
    },
    async heard({ pcm, rate }) {
      const whisper = await import("../whisper.js");
      const text = await whisper.transcribe(new Uint8Array(pcm), rate, lang, sttModelFor(lang));
      local("recognizer_loop:record_end");
      if (text) await ask_(text);
      return text;
    },
    heard_text: ({ text }) => { local("recognizer_loop:record_end"); return ask_(text); },
    say: ({ text }) => ask_(text),
    record_begin: () => local("recognizer_loop:record_begin"),
    wakeword: ({ name }) => local("recognizer_loop:wakeword", { hotword: name }),
    playback_started: ({ visemes }) => {
      local("recognizer_loop:audio_output_start");
      // the face's mouth, as the local OVOS does it (speech.py playback_started)
      if (visemes?.length) local("enclosure.mouth.viseme_list", { start: Date.now() / 1000, visemes });
    },
    playback_ended: () => local("recognizer_loop:audio_output_end"),
    // the visage's bus socket: what it says goes to the house
    core_open: () => null,
    core_send: ({ raw }) => { const m = JSON.parse(raw); return client?.emit(m.type, m.data, m.context); },
    gui_message: () => null,
    gui_sync: () => null,
    sound_bytes: () => null,
    res_file: () => null,
    phal_event: () => null,
    phal_position: () => null,
    sync: () => null,
    python: () => "",
    net_log: () => [],
    net_clear: () => null,
  };

  return {
    kind: "hivemind",
    can: { panel: false, store: false, install: false, netlog: false, gui: false },
    async call(cmd, args = {}) {
      const f = commands[cmd];
      if (!f) throw new Error(`"${cmd}" is not there with a HiveMind brain`);
      return f(args);
    },
    on(kind, fn) {
      if (!handlers.has(kind)) handlers.set(kind, new Set());
      handlers.get(kind).add(fn);
    },
    emit: (type, data = {}, context = {}) => client?.emit(type, data, context),
    onMessage(fn) { busListeners.add(fn); },
    offMessage(fn) { busListeners.delete(fn); },
    stop() { client?.close(); },
  };
}
