// Emkay – the OVOS side of the page.
//
// Pyodide runs in this (module) Web Worker, so a busy Python (a slow skill,
// a padaos compile) never freezes the face. The page sends commands and gets
// answers and events back:
//
//   page -> worker   {id, cmd, ...args}
//   worker -> page   {id, result} | {id, error}            answer to a command
//                    {kind: "status", text, progress}      boot progress
//                    {kind: "gui"|"audio"|"bus", payload[, data]}   from OVOS
//
// What is downloaded, and from where, is described by build.json, which
// tools/build_site.py writes next to this file.

import { matchLang } from "./langs.js";
import * as netlog from "./netlog.js";

// every request this worker makes goes into the network log (netlog.js),
// which also keeps "local only" (ovos-phal-plugin-browser switches it through emkayNet)
netlog.install();
globalThis.emkayNet = { setLocalOnly: netlog.setLocalOnly, isLocalOnly: netlog.isLocalOnly };

// A speech model's download (whisper.js, piper.js), for the page's status
// line (app.js onModel): what ("stt", "tts"), its name, progress 0..1 and
// state ("loading", "ready", "error"). Progress is sent at most every 300 ms.
const lastProgress = new Map();
globalThis.emkayModelProgress = (what, name, progress, state = "loading") => {
  const key = `${what}:${name}`, now = Date.now();
  if (state === "loading" && progress > 0 && now - (lastProgress.get(key) || 0) < 300) return;
  lastProgress.set(key, now);
  self.postMessage({ kind: "model", payload: { what, name, progress, state } });
};

// Piper TTS (web/piper.js), for ovos-tts-plugin-piper-browser through `js`;
// loaded the first time a Piper voice speaks
globalThis.emkayPiper = {
  synth: async (text, voice, speaker) => (await import("./piper.js")).synth(text, voice, speaker),
  ready: async (voice) => (await import("./piper.js")).ready(voice),
};

// Whisper STT on the phone (web/whisper.js), for ovos-stt-plugin-whisper-browser
// through `js`; loaded the first time Whisper is chosen
globalThis.emkayWhisper = {
  ready: async (model) => (await import("./whisper.js")).ready(model),
  transcribe: async (pcm, rate, lang, model) =>
    (await import("./whisper.js")).transcribe(pcm, rate, lang, model),
};

let py = null;    // the Pyodide instance
let main = null;  // the Python module emkay_mobile.worker_main
const build = fetch("build.json", { cache: "no-cache" }).then((r) => r.json());

/** Tell the page how the boot is going (shown on the start screen). */
function status(key, progress, vars) {
  self.postMessage({ kind: "status", key, vars, progress });   // texts: i18n.js
}

/**
 * Called from Python (worker_main._post) with something for the page.
 * `data`, when given, is a Uint8Array; its buffer is transferred, not copied.
 */
function post(kind, payload, data) {
  if (data) {
    const bytes = data.slice();  // own buffer, so it can be transferred
    self.postMessage({ kind, payload: JSON.parse(payload), data: bytes.buffer }, [bytes.buffer]);
  } else {
    self.postMessage({ kind, payload });
  }
}

/** Fetch a file as bytes, reporting progress under `label`. */
async function fetchBytes(url, label, vars) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const total = Number(r.headers.get("content-length")) || 0;
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) status(label, got / total, vars);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Copy the IndexedDB-backed folders in (populate=true) or out (false). */
function syncfs(populate) {
  return new Promise((ok, fail) => py.FS.syncfs(populate, (e) => (e ? fail(e) : ok())));
}

/**
 * The languages OVOS will boot in, of those the site has pre-trained
 * intents for: its `lang` and `secondary_langs` as ovos-config merges them
 * (the user layer mycroft.conf over the assistant layer runtime.conf),
 * else the phone's language as boot._phone_language picks it, else en-US.
 * Read from the files before Python runs, so only these are downloaded.
 */
function bootLanguages(siteLangs) {
  const read = (name) => {
    try { return JSON.parse(py.FS.readFile(`/home/pyodide/.config/mycroft/${name}`, { encoding: "utf8" })); }
    catch { return {}; }
  };
  const user = read("mycroft.conf");
  const assistant = read("runtime.conf");
  const phone = (self.navigator.languages || [self.navigator.language])
    .map((l) => matchLang(l, siteLangs)).find(Boolean);
  const lang = matchLang(user.lang ?? assistant.lang, siteLangs) ?? phone
    ?? matchLang("en-US", siteLangs) ?? siteLangs[0];
  const extra = (user.secondary_langs ?? assistant.secondary_langs ?? [])
    .map((l) => matchLang(l, siteLangs)).filter(Boolean);
  return [...new Set([lang, ...extra])].filter(Boolean);
}

/**
 * Start Python, unpack OpenVoiceOS and boot it. Only the intent caches and
 * m2v models of the languages OVOS boots in are fetched (bootLanguages);
 * downloads already on this device (same hash) are skipped.
 */
async function boot({ userConfig }) {
  const b = await build;
  status("boot.python");
  const index = new URL(b.pyodide_index, self.location).href;  // served with the site
  const { loadPyodide } = await import(`${index}pyodide.mjs`);   // Pyodide 314: module workers only
  py = await loadPyodide({ indexURL: index });

  // ~/.config (mycroft.conf, skill settings) and ~/.local (intent cache,
  // models, skill data) live in IndexedDB, like the disk of a device.
  const home = "/home/pyodide";
  for (const d of [".config", ".local"]) {
    py.FS.mkdirTree(`${home}/${d}`);
    py.FS.mount(py.FS.filesystems.IDBFS, {}, `${home}/${d}`);
  }
  await syncfs(true);
  netlog.attach(py.FS);   // the log's file is in ~/.local

  status("boot.packages");
  await py.loadPackage(b.pyodide_packages, { messageCallback: () => {} });

  const bundle = await fetchBytes(b.bundle, "boot.ovos");
  py.FS.writeFile("/tmp/bundle.zip", bundle);

  // which downloads this device already has, by hash
  const stamp = `${home}/.local/share/emkay-mobile/downloads.json`;
  let have = {};
  try { have = JSON.parse(py.FS.readFile(stamp, { encoding: "utf8" })); } catch {}
  const langs = bootLanguages(Object.keys(b.intent_cache || {}));
  const bases = new Set(langs.map((l) => l.split("-")[0].toLowerCase()));
  for (const [lang, entry] of Object.entries(b.intent_cache || {})) {
    if (!langs.includes(lang) || have[`intents-${lang}`] === entry.hash) continue;
    const zip = await fetchBytes(entry.url, "boot.intents", { lang });
    py.FS.writeFile(`/tmp/intents-${lang}.zip`, zip);
    have[`intents-${lang}`] = entry.hash;
  }
  for (const [lang, entry] of Object.entries(b.m2v_models || {})) {
    if (!bases.has(lang) || have[`m2v-${lang}`] === entry.hash) continue;
    const zip = await fetchBytes(entry.url, "boot.m2v", { lang });
    py.FS.writeFile(`/tmp/m2v-${lang}.zip`, zip);
    have[`m2v-${lang}`] = entry.hash;
  }

  status("boot.unpack");
  py.globals.set("DOWNLOADS", JSON.stringify(have));
  await py.runPythonAsync(`
import glob, os, site, zipfile, importlib
# the OVOS packages: a fresh copy every boot, from the browser's HTTP cache
zipfile.ZipFile("/tmp/bundle.zip").extractall(site.getsitepackages()[0])
os.remove("/tmp/bundle.zip")
# pre-trained padatious networks, where padatious keeps its cache
for z in glob.glob("/tmp/intents-*.zip"):
    zipfile.ZipFile(z).extractall(os.path.expanduser("~/.local/share/mycroft"))
    os.remove(z)
# m2v intent models, one folder per language (see boot.M2V_DIR)
for z in glob.glob("/tmp/m2v-*.zip"):
    zipfile.ZipFile(z).extractall(os.path.expanduser("~/.local/share/emkay-mobile/m2v"))
    os.remove(z)
os.makedirs(os.path.expanduser("~/.local/share/emkay-mobile"), exist_ok=True)
with open(os.path.expanduser("~/.local/share/emkay-mobile/downloads.json"), "w") as f:
    f.write(DOWNLOADS)
importlib.invalidate_caches()
`);
  // the browser knows its time zone; the timezonefinder stand-in reports it
  py.runPython(`import os; os.environ["EMKAY_TZ"] = ${JSON.stringify(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
  // OVOS' default language is the phone's when the site has intents for it
  // (boot._phone_language); these are the phone's languages and the site's
  py.globals.set("PHONE_LANGS", (self.navigator.languages || [self.navigator.language]).join(","));
  py.globals.set("SITE_LANGS", Object.keys(b.intent_cache || {}).join(","));
  py.runPython(`import os; os.environ["EMKAY_PHONE_LANGS"] = PHONE_LANGS; os.environ["EMKAY_SITE_LANGS"] = SITE_LANGS`);

  status("boot.start");
  main = py.pyimport("emkay_mobile.worker_main");
  const info = JSON.parse(main.start(post, userConfig ? py.toPy(userConfig) : null));
  info.site_langs = Object.keys(b.intent_cache || {});
  info.wake_words = b.wake_words || [];   // what wakeword.js can hear (app.js)
  info.precise_models = b.precise_models || {};   // Precise models on the site, by OVOS' model URL
  info.intent_langs = langs;   // what this boot has intents for (app.js)
  status("boot.ready", 1);
  // Python's deferred work (padatious' training pass) runs from here on,
  // whenever this worker is idle. Keep the disk in step with what skills
  // and the setup page write.
  syncfs(false).catch(() => {});
  setInterval(() => syncfs(false).catch(() => {}), 10000);
  return info;
}

/**
 * Call a Python function so that it may wait (JSPI, issue #20): entered
 * with callPromising, a time.sleep or Event.wait in it suspends Python
 * where it is, and this worker goes on with the page's next messages. Where
 * the browser has no JSPI (older browsers) it is an ordinary call, and Python's
 * waits return at once (browser.py).
 */
const promising = (fn, ...args) => (fn.callPromising ? fn.callPromising(...args) : fn(...args));

/** Everything the page can ask for. Each returns a value or a Promise. */
const commands = {
  boot,
  gui_message: ({ raw }) => promising(main.gui_message, raw),
  // the visage (web/visage2-shim.js): its bus socket, GUI resync, res/ files
  core_open: ({ open }) => main.core_open(open),
  core_send: ({ raw }) => promising(main.core_send, raw),
  gui_sync: () => promising(main.gui_sync),
  res_file: ({ path }) => main.res_file(path) ?? null,   // a Uint8Array or null
  say: ({ text }) => promising(main.say, text),
  record_begin: () => promising(main.record_begin),
  wakeword: ({ name }) => promising(main.wakeword, name),
  heard_text: ({ text }) => promising(main.heard_text, text),
  sound_bytes: ({ uri }) => main.sound_bytes(uri),
  heard: ({ pcm, rate }) => promising(main.heard, new Uint8Array(pcm), rate),
  playback_started: ({ ident, visemes }) => promising(main.playback_started, ident, JSON.stringify(visemes || [])),
  playback_ended: ({ ident }) => promising(main.playback_ended, ident),
  /** One request for the settings panel (see sw.js and panel.py). */
  panel_request: async ({ method, path, query, headers, body }) =>
    main.panel_request(method, path, query, JSON.stringify(headers), body ? new Uint8Array(body) : null),
  /** Something the page saw for the PHAL plugin (device.js, ovos-phal-plugin-browser). */
  phal_event: ({ event, data }) => promising(main.phal_event, event, JSON.stringify(data ?? {})),
  /** Write the IndexedDB-backed folders now (before a reload). */
  sync: () => syncfs(false),
  /** The page's answer to the PHAL plugin's location request. */
  phal_position: ({ lat, lon, error }) => promising(main.phal_position, lat ?? null, lon ?? null, error ?? null),
  /** The network log: every request this worker made in the last days (netlog.js). */
  net_log: () => netlog.entries(),
  net_clear: () => netlog.clear(),
  /** Run a line of Python and return its value as text (for debugging). */
  python: ({ code }) => String(py.runPython(code)),
  /** The same through runPythonAsync: Python that may wait (JSPI, issue #20). */
  python_async: async ({ code }) => String(await py.runPythonAsync(code)),
};

self.onmessage = async (event) => {
  const { id, cmd, ...args } = event.data;
  try {
    const result = await commands[cmd](args);
    self.postMessage({ id, result: result?.toJs ? result.toJs() : result });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
