// Emkay – the Home Assistant brain (issue #29): Emkay as an Assist device.
// The phone keeps the body – face, wake word, microphone, speaker – and
// Home Assistant's Assist is the brain: what Emkay hears goes to the
// pipeline chosen in HA, and HA's answer comes back to be spoken.
//
// Two things run over one connection to HA's WebSocket API:
//
//   the device   ovos/connect + ovos/bus, from the general OpenVoiceOS
//                integration (andlo/ha-ovos-integration, docs/protocol.md):
//                Emkay becomes a device in HA with volume, listening on/off,
//                state, its sensors, "say something" – HA asks over the OVOS
//                bus and this brain answers, as an OVOS would
//   the voice    HA's own assist_pipeline/run: the recording after the wake
//                word goes to the pipeline's speech-to-text, then its
//                conversation agent and text-to-speech; the events come back
//                as OVOS bus messages (record_end, utterance, speak,
//                audio_output_*), so the face reacts as with its own OVOS
//
// Login is HA's own login page (OAuth2 / IndieAuth with Emkay's address as
// client_id) – nobody copies a token. The refresh token stays in this
// browser ("emkay-ha" in localStorage).
//
// Wake word on the phone ("hey emkay"). Where the pipeline has no
// speech-to-text, the phone's own (whisper.js) is used and only the text
// goes; where it has no text-to-speech, or its audio can't be fetched, the
// phone speaks (piper.js).

import { t } from "../i18n.js";
import { setBrain } from "./saved.js";
import { sttModelFor, textVisemes, voiceFor, wavSeconds } from "./hivemind-brain.js";

const KEY = "emkay-ha";
const STATE_KEY = "emkay-ha-login";      // sessionStorage: the login's state value
const PROTOCOL = 1;
const WHISPER_STT = "ovos-stt-plugin-whisper-browser";
const CONVERSATION_KEEP_MS = 5 * 60e3;   // follow-up questions keep HA's conversation

/** Settings from localStorage: {url, refresh, device_id, name, pipeline}. */
export function haSettings() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null") || {}; } catch { return {}; }
}
export function saveHaSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

/** "homeassistant.local:8123" -> "http(s)://homeassistant.local:8123" */
export function normalizeUrl(raw) {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `${location.protocol === "https:" ? "https" : "http"}://${u}`;
  try { return new URL(u).origin; } catch { return ""; }
}

/** Emkay's identity towards HA's login: its own address (IndieAuth). */
const clientId = () => `${location.origin}/`;
const redirectUri = () => `${location.origin}${location.pathname}`;

/** Off to HA's login page; it comes back here with ?code=…&state=… */
export function goLogin(url) {
  const state = `emkay-ha.${crypto.randomUUID()}`;
  try { sessionStorage.setItem(STATE_KEY, state); } catch {}
  const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri(), state });
  location.assign(`${url}/auth/authorize?${q}`);
}

/** Back from HA's login page: the code, once (and dropped from the address). */
function takeLoginCode() {
  const p = new URLSearchParams(location.search);
  const code = p.get("code"), state = p.get("state");
  if (!code || !state?.startsWith("emkay-ha.")) return null;
  let expected = null;
  try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch {}
  history.replaceState(null, "", location.pathname);
  return state === expected ? code : null;
}

async function token(url, form) {
  const r = await fetch(`${url}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), ...form }),
  });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: r.status === 400 ? "login" : "unreachable" });
  return r.json();
}

/**
 * Ask for HA's address in a small form over the boot screen, as the
 * HiveMind brain does. Resolves with the address, or null (Back).
 */
export function askHaUrl(prev = "", error = "", { back = false, local = false } = {}) {
  return new Promise((resolve) => {
    document.getElementById("ha-setup")?.remove();
    const form = document.createElement("form");
    form.id = "ha-setup";
    form.className = "hivemind-setup";
    form.innerHTML = `
      <h2>${t("ha.title")}</h2>
      <p>${t("ha.hint")}</p>
      ${error ? `<p class="error"></p>` : ""}
      <label>${t("ha.url")}<input name="url" type="text" value="" required autocapitalize="off"
        spellcheck="false" inputmode="url" placeholder="https://homeassistant.local:8123"></label>
      <button type="submit">${t("ha.login")}</button>
      ${back ? `<button type="button" class="secondary" data-act="back">${t("hivemind.back")}</button>` : ""}
      ${local ? `<button type="button" class="secondary" data-act="local">${t("hivemind.use_local")}</button>` : ""}`;
    form.querySelector("input").value = prev;
    if (error) form.querySelector(".error").textContent = error;   // text, not HTML
    form.querySelector('[data-act="back"]')?.addEventListener("click", () => { form.remove(); resolve(null); });
    form.querySelector('[data-act="local"]')?.addEventListener("click", () => {
      setBrain("local");
      location.replace(location.pathname);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const url = normalizeUrl(new FormData(form).get("url"));
      if (!url) return;
      if (location.protocol === "https:" && url.startsWith("http:")) {
        form.querySelector(".error")?.remove();
        const p = document.createElement("p");
        p.className = "error";
        p.textContent = t("ha.needs_https");
        form.querySelector("p").after(p);
        return;
      }
      form.remove();
      resolve(url);
    };
    document.body.append(form);
  });
}

/** HA's WebSocket API: commands, subscriptions, binary audio. */
class HaSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url.replace(/^http/, "ws") + "/api/websocket";
    this.nextId = 1;
    this.waiting = new Map();   // id -> {resolve, reject}
    this.subs = new Map();      // id -> fn(event)
  }

  open(accessToken) {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      const fail = () => reject(Object.assign(new Error("closed"), { code: "unreachable" }));
      ws.onerror = fail;
      ws.onclose = () => { fail(); this.dispatchEvent(new Event("close")); };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: accessToken }));
        else if (msg.type === "auth_ok") { this.version = msg.ha_version; resolve(); }
        else if (msg.type === "auth_invalid") reject(Object.assign(new Error(msg.message), { code: "login" }));
        else if (msg.type === "result") {
          const w = this.waiting.get(msg.id);
          this.waiting.delete(msg.id);
          if (w) msg.success ? w.resolve(msg.result) : w.reject(Object.assign(new Error(msg.error?.message), { code: msg.error?.code }));
        } else if (msg.type === "event") this.subs.get(msg.id)?.(msg.event);
      };
    });
  }

  command(msg) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, ...msg }));
    });
  }

  /** A subscription: resolves with its id once HA accepted it. */
  async subscribe(msg, onEvent) {
    const id = this.nextId;
    this.subs.set(id, onEvent);
    try { await this.command(msg); } catch (e) { this.subs.delete(id); throw e; }
    return id;
  }

  unsubscribe(id) {
    this.subs.delete(id);
    this.command({ type: "unsubscribe_events", subscription: id }).catch(() => {});
  }

  /** Audio for a pipeline run: the handler id's byte, then the PCM. */
  sendAudio(handler, bytes) {
    const out = new Uint8Array(1 + (bytes?.byteLength || 0));
    out[0] = handler;
    if (bytes) out.set(new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength), 1);
    this.ws.send(out);
  }

  close() { this.ws?.close(); }
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** The site's build info (wake words, models), fetched once. */
let buildInfo = null;
const getBuild = async () => (buildInfo ??= await fetch("build.json", { cache: "no-cache" })
  .then((r) => r.json()).catch(() => ({})));

/** "hey_emkay" -> "Hey Emkay" (as HA shows it in the wake word choice) */
const phrase = (id) => id === "hey_emkay" ? "Hey Emkay"
  : id.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

/**
 * The wake words this site has, the one in use (saved choice, else Emkay's
 * own "hey M K" where there is one, else "hey mycroft"), and how to load it.
 */
function wakeWords(build, chosen) {
  const ids = build.wake_words || [];
  const precise = build.precise_models || {};
  const heyMycroft = Object.keys(precise).find((u) => /hey_mycroft/.test(u));
  const current = (chosen && ids.includes(chosen) && chosen)
    || (ids.includes("hey_emkay") ? "hey_emkay" : "hey_mycroft");
  const hotword = (ww) => ww === "hey_mycroft" && heyMycroft
    ? { module: "ovos-ww-plugin-precise-onnx", model: heyMycroft }
    : { module: "ovos-ww-plugin-openwakeword", threshold: ww === "hey_emkay" ? 0.8 : 0.5 };
  return { ids, current, hotword, precise };
}

/**
 * @param {object} [opts]
 * @param {typeof askHaUrl} [opts.ask]  how to ask for HA's address
 * @returns {import("./brain.js").Brain}
 */
export function createHomeAssistantBrain({ ask = askHaUrl } = {}) {
  const handlers = new Map();
  const busListeners = new Set();
  const fire = (kind, data) => { for (const fn of handlers.get(kind) || []) fn(data); };

  let settings = haSettings();
  let ha = null;            // HaSocket
  let lang = navigator.language || "en-US";
  let pipeline = null;      // the chosen pipeline (assist_pipeline/pipeline/list)
  let forward = new Set();  // bus message types HA wants (ready event)
  let haDeviceId = null;    // HA's id for this device (ready event)
  let ready = false;
  let satellite = false;    // the integration runs Assist for Emkay as a satellite (#11)
  // what to do when each queued sound has finished playing, in order
  // (playback_ended): tell HA an answer or announcement is done, listen…
  const afterPlayback = [];
  let conversation = { id: null, at: 0 };
  let listenAgain = false;  // the agent asked a question back
  let nextIdent = 1;
  // what HA can see and set on this device
  const level = { volume: 0.75, muted: false };
  let micMuted = false;
  try { Object.assign(level, JSON.parse(localStorage.getItem("emkay-ha-volume") || "{}")); } catch {}

  /** To HA, if it asked for this kind of message. */
  function toHA(type, data = {}) {
    if (!ready || !forward.has(type)) return;
    ha.command({ type: "ovos/bus", device_id: settings.device_id, message: { type, data, context: {} } })
      .catch(() => {});
  }

  /** A bus message on the page (the visage, app.js' onBus) – and to HA. */
  function local(type, data = {}, context = {}) {
    const raw = JSON.stringify({ type, data, context });
    for (const fn of busListeners) fn(raw);
    fire("bus", { payload: raw });
    toHA(type, data);
  }

  // ------------------------------------------------------------- login
  /**
   * An access token: from the code HA's login page sent back, else from the
   * kept refresh token, else off to HA's login page. A revoked refresh token
   * means logging in again; HA just being away (a restart) is thrown, for
   * the caller to try again – it never asks for the address again.
   */
  async function login() {
    const code = takeLoginCode();
    if (!settings.url) {
      const url = await ask("", "", { local: true });
      settings = { ...settings, url, refresh: null };
      saveHaSettings(settings);
      goLogin(url);
      return new Promise(() => {});   // the page leaves for HA's login
    }
    try {
      if (code) {
        const tok = await token(settings.url, { grant_type: "authorization_code", code });
        settings = { ...settings, refresh: tok.refresh_token };
        saveHaSettings(settings);
        return tok.access_token;
      }
      if (settings.refresh) {
        const tok = await token(settings.url, { grant_type: "refresh_token", refresh_token: settings.refresh });
        return tok.access_token;
      }
    } catch (e) {
      if (e.code !== "login") throw Object.assign(e, { code: e.code || "unreachable" });
      settings = { ...settings, refresh: null };   // revoked: log in again
      saveHaSettings(settings);
    }
    goLogin(settings.url);
    return new Promise(() => {});
  }

  async function connect() {
    fire("status", { key: "ha.connecting", vars: { url: settings.url } });
    const access = await login();
    const sock = ha = new HaSocket(settings.url);
    await sock.open(access);
    try {
      await choosePipeline();   // fails while HA is still starting (no assist_pipeline yet)
      await joinAsDevice();
    } catch (e) {
      sock.close();
      throw e;
    }
    // only a socket that got all the way watches for its end: one reconnect at a time
    sock.addEventListener("close", () => {
      ready = false;
      fire("status", { key: "ha.lost", vars: { url: settings.url } });
      setTimeout(reconnect, 3000);
    });
  }

  async function reconnect() {
    try {
      await connect();
      fire("status", { key: "ha.connected", progress: 1, vars: { url: settings.url } });
    } catch (e) {
      console.warn("[emkay] ha reconnect", e);
      setTimeout(reconnect, 10000);
    }
  }

  /** The pipeline Emkay uses: the saved one, else HA's preferred. Emkay's language follows it. */
  async function choosePipeline() {
    const { pipelines, preferred_pipeline } = await ha.command({ type: "assist_pipeline/pipeline/list" });
    pipeline = pipelines.find((p) => p.id === settings.pipeline)
      || pipelines.find((p) => p.id === preferred_pipeline) || pipelines[0] || null;
    if (pipeline?.language) lang = pipeline.language;
  }

  // ------------------------------------------------- the device (ovos/*)
  async function joinAsDevice() {
    if (!settings.device_id) {
      settings = { ...settings, device_id: `emkay-${crypto.randomUUID()}` };
      saveHaSettings(settings);
    }
    const build = await getBuild();
    const ww = wakeWords(build, settings.wakeWord);
    try {
      await ha.subscribe({
        type: "ovos/connect", protocol: PROTOCOL,
        device_id: settings.device_id,
        name: settings.name || "Emkay",
        model: "Emkay", manufacturer: "Emkay",
        satellite: true,          // audio goes to HA: an Assist satellite there
        // its wake word is chosen in HA too (the satellite's configuration)
        wake_words: ww.ids.map((id) => ({ id, wake_word: phrase(id) })),
        wake_word: ww.current,
        sw_version: build.version || undefined,
        lang,
      }, onDeviceEvent);
    } catch (e) {
      // the voice works without it: an HA without the integration, or
      // without "Let OpenVoiceOS devices connect", is still a brain
      console.warn("[emkay] ha: not a device in HA –", e.code, e.message);
    }
  }

  function onDeviceEvent(ev) {
    switch (ev.type) {
      case "pending":
        ready = false;
        fire("status", { key: "ha.pending" });
        break;
      case "ready":
        forward = new Set(ev.forward || []);
        haDeviceId = ev.device_id || null;
        satellite = (ev.features || []).includes("satellite");
        ready = true;
        fire("status", { key: "ha.connected", progress: 1, vars: { url: settings.url } });
        break;
      case "bus":
        fromHA(ev.message);
        break;
      case "announce":
        announce(ev);
        break;
      case "wake_word": {           // chosen in HA
        const ww = wakeWords(buildInfo || {}, ev.id);
        settings = { ...settings, wakeWord: ww.current };
        saveHaSettings(settings);
        local("emkay.wakeword", { wake_word: ww.current, hotword: ww.hotword(ww.current) });
        break;
      }
      case "media":
        media(ev);
        break;
      case "timer":
        if (ev.event === "finished") {
          const name = ev.timer?.name;
          speak(name ? t("ha.timer_done_named", { name }) : t("ha.timer_done"), lang);
        }
        break;
      case "displaced":
      case "removed":
        ready = false;
        console.warn(`[emkay] ha: device ${ev.type}`);
        break;
    }
  }

  /** A sound for app.js' speaker, and what to do once it has played. */
  function play(payload, data, after = null) {
    afterPlayback.push(after);
    fire("audio", { payload, data });
  }

  /** HA's own sound (TTS, announcements) through the integration's CORS path. */
  async function fetchHA(url) {
    const r = await fetch(new URL(url, settings.url));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.arrayBuffer();
  }

  async function duration(data, text) {
    return new OfflineAudioContext(1, 1, 44100).decodeAudioData(data.slice(0))
      .then((b) => b.duration).catch(() => text.length * 0.07);
  }

  // ---------------------------------------------------- the media player
  // HA's media_player for Emkay: sounds, radio, music from HA. An audio
  // element (a URL on HA needs no CORS for it), at Emkay's volume.
  let mediaEl = null;
  function mediaState() {
    const state = !mediaEl?.src || mediaEl.ended ? "idle" : mediaEl.paused ? "paused" : "playing";
    ha?.command({ type: "ovos/satellite/media", device_id: settings.device_id, state,
                  url: state === "idle" ? null : mediaEl.dataset.url }).catch(() => {});
  }
  function media({ command, url }) {
    if (!mediaEl) {
      mediaEl = new Audio();
      for (const e of ["playing", "pause", "ended", "emptied", "error"]) mediaEl.addEventListener(e, mediaState);
    }
    mediaEl.volume = level.muted ? 0 : level.volume;
    if (command === "play" && url) {
      mediaEl.dataset.url = url;
      mediaEl.src = new URL(url, settings.url).href;
      mediaEl.play().catch((e) => console.warn("[emkay] ha media", e));
    } else if (command === "pause") mediaEl.pause();
    else if (command === "resume") mediaEl.play().catch(() => {});
    else if (command === "stop") { mediaEl.pause(); mediaEl.removeAttribute("src"); mediaEl.load(); mediaState(); }
  }

  /** An announcement (or the start of a conversation) from an automation. */
  async function announce({ id, message, media_url: url, start_conversation }) {
    const done = () => {
      ha.command({ type: "ovos/satellite/done", device_id: settings.device_id, what: "announce", announce_id: id })
        .catch(() => {});
      if (start_conversation) local("mycroft.mic.listen");   // the answer, without the wake word
    };
    if (message) local("speak", { utterance: message, lang });
    try {
      if (!url) throw new Error("no audio");
      const data = await fetchHA(url);
      const visemes = textVisemes(message || "", await duration(data, message || ""));
      play({ ident: `ha-${nextIdent++}`, utterance: message, visemes }, data, done);
    } catch {
      if (message) speak(message, lang, done);
      else done();
    }
  }

  function setLevel(next) {
    Object.assign(level, next);
    level.volume = Math.max(0, Math.min(1, level.volume));
    try { localStorage.setItem("emkay-ha-volume", JSON.stringify(level)); } catch {}
    fire("phal", { payload: JSON.stringify({ volume: level.volume, muted: level.muted }) });
    if (mediaEl) mediaEl.volume = level.muted ? 0 : level.volume;
    toHA("mycroft.volume.get.response", { percent: level.volume, muted: level.muted });
  }

  /** What HA asks of the device, in OVOS' words – answered as an OVOS would. */
  function fromHA(msg) {
    const d = msg.data || {};
    switch (msg.type) {
      case "mycroft.volume.get":
        return toHA("mycroft.volume.get.response", { percent: level.volume, muted: level.muted });
      case "mycroft.volume.set":
        return setLevel({ volume: Number(d.percent ?? level.volume) });
      case "mycroft.volume.increase":
        return setLevel({ volume: level.volume + Number(d.percent ?? 0.1) });
      case "mycroft.volume.decrease":
        return setLevel({ volume: level.volume + Number(d.percent ?? -0.1) });
      case "mycroft.volume.mute":
      case "mycroft.volume.unmute":
        return setLevel({ muted: msg.type.endsWith(".mute") });
      case "mycroft.mic.get_status":
        return toHA("mycroft.mic.get_status.response", { muted: micMuted });
      case "mycroft.mic.mute":
      case "mycroft.mic.unmute":
        micMuted = msg.type.endsWith(".mute");
        return local(msg.type);             // app.js' mic follows it
      case "mycroft.mic.listen":
      case "mycroft.stop":
        return local(msg.type);
      case "speak":                         // HA's "Say": the phone's own voice
        if (d.utterance) { local("speak", d); speak(d.utterance, d.lang || lang); }
        return;
      case "recognizer_loop:utterance": {   // HA's "Ask": as if it had been said
        const text = (d.utterances || [])[0];
        if (text) askText(text);
        return;
      }
    }
  }

  // ------------------------------------------------- the voice (Assist)
  /**
   * One pipeline run, from `start` ("stt" with audio, "intent" with text)
   * to text-to-speech where the pipeline has it. Resolves with what was
   * heard (stt) as soon as it is known; the answer follows on its own.
   */
  function run(start, { pcm, rate, text } = {}) {
    if (Date.now() - conversation.at > CONVERSATION_KEEP_MS) conversation.id = null;
    const end = pipeline?.tts_engine ? "tts" : "intent";
    return new Promise((resolveHeard) => {
      let heard = text ?? "", answer = "", subId = null, done = false, voiced = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolveHeard(heard);
        if (subId !== null) ha.unsubscribe(subId);
        local("ovos.utterance.handled");    // unanswered() waits for this
      };
      const sendAudio = (handler) => {
        // the whole recording at once (app.js' VAD already ended it), then the end
        const bytes = new Uint8Array(pcm);
        for (let i = 0; i < bytes.length; i += 32000) ha.sendAudio(handler, bytes.subarray(i, i + 32000));
        ha.sendAudio(handler, null);
      };
      const onEvent = async (ev) => {
        const data = ev.data || {};
        switch (ev.type) {
          case "init":   // ovos/satellite/run: where the audio goes
            if (start === "stt" && ev.handler_id != null) sendAudio(ev.handler_id);
            break;
          case "run-start": {
            const handler = data.runner_data?.stt_binary_handler_id;
            if (!viaSatellite && start === "stt" && handler != null) {
              sendAudio(handler);
            }
            break;
          }
          case "stt-end":
            heard = data.stt_output?.text || "";
            resolveHeard(heard);
            if (heard) local("recognizer_loop:utterance", { utterances: [heard], lang });
            break;
          case "intent-end": {
            const out = data.intent_output || {};
            conversation = { id: out.conversation_id || null, at: Date.now() };
            listenAgain = !!out.continue_conversation;
            answer = out.response?.speech?.plain?.speech || "";
            if (answer) local("speak", { utterance: answer, lang });
            if (answer && end === "intent" && !viaSatellite) { voiced = true; speak(answer, lang, ttsDone); }
            break;
          }
          case "tts-end":
            voiced = true;
            if (answer) playHA(data.tts_output, answer, ttsDone);
            else ttsDone();
            break;
          case "error":
            console.warn("[emkay] assist", data.code, data.message);
            finish();
            break;
          case "run-end":
            // the pipeline HA chose for the satellite has no text-to-speech
            if (answer && !voiced) speak(answer, lang, ttsDone);
            finish();
            break;
        }
      };
      // as a satellite, HA runs the pipeline chosen for Emkay in HA and keeps
      // the conversation; else Emkay runs its pipeline itself
      const viaSatellite = satellite && ready;
      const ttsDone = () => {
        if (viaSatellite) ha.command({ type: "ovos/satellite/done", device_id: settings.device_id, what: "tts" }).catch(() => {});
      };
      const msg = viaSatellite
        ? { type: "ovos/satellite/run", device_id: settings.device_id, start_stage: start,
            ...(start === "stt" ? {} : { text }) }
        : { type: "assist_pipeline/run", start_stage: start, end_stage: end,
            input: start === "stt" ? { sample_rate: rate } : { text },
            conversation_id: conversation.id,
            ...(pipeline ? { pipeline: pipeline.id } : {}),
            ...(haDeviceId ? { device_id: haDeviceId } : {}) };
      ha.subscribe(msg, onEvent).then((id) => { subId = id; if (done) ha.unsubscribe(id); })
        .catch((e) => { console.warn("[emkay] assist", e); finish(); });
    });
  }

  /** HA's own voice: its TTS audio, through the integration's CORS-able path. */
  async function playHA(out, text, after = null) {
    try {
      const tok = out?.token || out?.url?.split("/").pop();
      if (!tok) throw new Error("no tts token");
      const data = await fetchHA(`/api/ovos/tts/${tok}`)
        .catch(() => (out?.url ? fetchHA(out.url) : Promise.reject(new Error("no tts url"))));
      const visemes = textVisemes(text, await duration(data, text));
      play({ ident: `ha-${nextIdent++}`, utterance: text, visemes }, data, after);
    } catch (e) {
      console.warn("[emkay] ha tts, speaking on the phone instead:", e.message || e);
      speak(text, lang, after);
    }
  }

  /** The phone's own voice (piper.js), as the HiveMind brain. */
  async function speak(text, l, after = null) {
    const voice = voiceFor(l) || voiceFor(lang);
    try {
      if (!voice) throw new Error(`no Piper voice for ${l}`);
      const piper = await import("../piper.js");
      const wav = await piper.synth(text, voice);
      play({ ident: `ha-${nextIdent++}`, utterance: text, visemes: textVisemes(text, wavSeconds(wav)) }, wav.buffer, after);
    } catch (e) {
      console.warn("[emkay] speak", e);
      after?.();   // nothing to wait for
    }
  }

  async function askText(text) {
    local("recognizer_loop:utterance", { utterances: [text], lang });
    await run("intent", { text });
    return true;
  }

  const commands = {
    async boot() {
      fire("status", { key: "boot.loading" });
      // HA can't be reached at the first start: say so, and offer another
      // address or Emkay on this device (it never locks Emkay out)
      for (;;) {
        try { await connect(); break; } catch (e) {
          console.warn("[emkay] ha", e);
          ha?.close();
          const url = await ask(settings.url, t("ha.err.unreachable", { url: settings.url }), { local: true });
          if (url !== settings.url) {
            settings = { ...settings, url, refresh: null };
            saveHaSettings(settings);
            goLogin(url);
            await new Promise(() => {});
          }
        }
      }
      const build = await getBuild();
      const ww = wakeWords(build, settings.wakeWord);
      const wakeWord = ww.current, hotword = ww.hotword(wakeWord), precise = ww.precise, wakeWordList = ww.ids;
      if (!pipeline?.stt_engine) import("../whisper.js").then((w) => w.ready(sttModelFor(lang))).catch(() => {});
      if (!pipeline?.tts_engine && voiceFor(lang)) import("../piper.js").then((p) => p.ready(voiceFor(lang))).catch(() => {});
      fire("phal", { payload: JSON.stringify({ volume: level.volume, muted: level.muted }) });
      return {
        brain: "homeassistant", lang, skills: [], stt_module: WHISPER_STT,
        wake_word: wakeWord, hotword, precise_models: precise, wake_words: wakeWordList,
        site_langs: [lang], intent_langs: [lang], listener: {}, confirm_listening: false,
        pipeline: pipeline?.name,
      };
    },
    async heard({ pcm, rate }) {
      local("recognizer_loop:record_end");
      if (pipeline?.stt_engine) return run("stt", { pcm, rate });
      // no speech-to-text in the pipeline: the phone's own, then the text
      const whisper = await import("../whisper.js");
      const text = await whisper.transcribe(new Uint8Array(pcm), rate, lang, sttModelFor(lang));
      if (text) askText(text);
      return text;
    },
    heard_text: ({ text }) => { local("recognizer_loop:record_end"); return askText(text); },
    say: ({ text }) => askText(text),
    record_begin: () => local("recognizer_loop:record_begin"),
    wakeword: ({ name }) => local("recognizer_loop:wakeword", { hotword: name }),
    playback_started: ({ visemes }) => {
      local("recognizer_loop:audio_output_start");
      if (visemes?.length) local("enclosure.mouth.viseme_list", { start: Date.now() / 1000, visemes });
    },
    playback_ended: () => {
      local("recognizer_loop:audio_output_end");
      afterPlayback.shift()?.();
      // the agent asked something back: listen for the answer
      if (listenAgain) { listenAgain = false; local("mycroft.mic.listen"); }
    },
    // the phone's sensors (device.js), as ovos-phal-plugin-browser sends them
    phal_event: ({ event, data }) => {
      if (event !== "sensor" || !data) return null;
      const device = norm(data.device), name = norm(data.name);
      const friendly = `${device} ${name}`.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      toHA(data.binary ? "ovos.phal.binary_sensor" : "ovos.phal.sensor", {
        sensor_id: `${device}_${name}`, device_name: device, name, state: data.state,
        attributes: { friendly_name: friendly, ...(data.attributes || {}) },
      });
      return null;
    },
    // the visage's bus socket: nothing goes anywhere – HA has no OVOS bus
    core_open: () => null,
    core_send: () => null,
    gui_message: () => null,
    gui_sync: () => null,
    sound_bytes: () => null,
    res_file: () => null,
    phal_position: () => null,
    sync: () => null,
    python: () => "",
    net_log: () => [],
    net_clear: () => null,
  };

  return {
    kind: "homeassistant",
    can: { panel: false, store: false, install: false, netlog: false, gui: false },
    async call(cmd, args = {}) {
      const f = commands[cmd];
      if (!f) throw new Error(`"${cmd}" is not there with the Home Assistant brain`);
      return f(args);
    },
    on(kind, fn) {
      if (!handlers.has(kind)) handlers.set(kind, new Set());
      handlers.get(kind).add(fn);
    },
    emit: (type, data = {}) => { toHA(type, data); return Promise.resolve(); },
    onMessage(fn) { busListeners.add(fn); },
    offMessage(fn) { busListeners.delete(fn); },
    stop() { ha?.close(); },
  };
}
