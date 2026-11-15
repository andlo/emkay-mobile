// Emkay Mobile – the OVOS side of the page.
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
 * Start Python, unpack OpenVoiceOS and boot it. Downloads that are already
 * on this device (intent cache, m2v models with the same hash) are skipped.
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

  status("boot.packages");
  await py.loadPackage(b.pyodide_packages, { messageCallback: () => {} });

  const bundle = await fetchBytes(b.bundle, "boot.ovos");
  py.FS.writeFile("/tmp/bundle.zip", bundle);

  // which downloads this device already has, by hash
  const stamp = `${home}/.local/share/emkay-mobile/downloads.json`;
  let have = {};
  try { have = JSON.parse(py.FS.readFile(stamp, { encoding: "utf8" })); } catch {}
  for (const [lang, entry] of Object.entries(b.intent_cache || {})) {
    if (have[`intents-${lang}`] === entry.hash) continue;
    const zip = await fetchBytes(entry.url, "boot.intents", { lang });
    py.FS.writeFile(`/tmp/intents-${lang}.zip`, zip);
    have[`intents-${lang}`] = entry.hash;
  }
  for (const [lang, entry] of Object.entries(b.m2v_models || {})) {
    if (have[`m2v-${lang}`] === entry.hash) continue;
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
  status("boot.ready", 1);
  // Python's deferred work (padatious' training pass) runs from here on,
  // whenever this worker is idle. Keep the disk in step with what skills
  // and the setup page write.
  syncfs(false).catch(() => {});
  setInterval(() => syncfs(false).catch(() => {}), 10000);
  return info;
}

/** Everything the page can ask for. Each returns a value or a Promise. */
const commands = {
  boot,
  gui_snapshot: () => main.gui_snapshot(),
  gui_message: ({ raw }) => main.gui_message(raw),
  say: ({ text }) => main.say(text),
  record_begin: () => main.record_begin(),
  heard: ({ pcm, rate }) => main.heard(new Uint8Array(pcm), rate),
  playback_started: ({ ident, visemes }) => main.playback_started(ident, JSON.stringify(visemes || [])),
  playback_ended: ({ ident }) => main.playback_ended(ident),
  /** One request for the settings panel (see sw.js and panel.py). */
  panel_request: async ({ method, path, query, headers, body }) =>
    main.panel_request(method, path, query, JSON.stringify(headers), body ? new Uint8Array(body) : null),
  /** The page's answer to the PHAL plugin's location request. */
  phal_position: ({ lat, lon, error }) => main.phal_position(lat ?? null, lon ?? null, error ?? null),
  /** The settings as a zip (Uint8Array), after flushing them to disk. */
  export_settings: async () => {
    await syncfs(false);
    return main.export_settings().toJs();
  },
  /** Replace the settings with a zip; the page reloads afterwards. */
  import_settings: async ({ data }) => {
    const manifest = JSON.parse(main.import_settings(new Uint8Array(data)));
    await syncfs(false);
    return manifest;
  },
  /** Run a line of Python and return its value as text (for debugging). */
  python: ({ code }) => String(py.runPython(code)),
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
