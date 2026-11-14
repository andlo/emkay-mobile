// Emkay Mobile – the OVOS side. Runs Pyodide in a (module) Web Worker so a busy
// Python (training, a slow skill) never freezes the face.
//
// Page -> worker: {id, cmd, ...args}   worker -> page: {id, result|error} or
// {kind: "status"|"gui"|"audio"|"bus", ...}.

let py = null;
let main = null;
const build = fetch("build.json", { cache: "no-cache" }).then((r) => r.json());

function status(text, progress) {
  self.postMessage({ kind: "status", text, progress });
}

function post(kind, payload, data) {
  if (data) {
    const bytes = data.slice();  // own buffer, so it can be transferred
    self.postMessage({ kind, payload: JSON.parse(payload), data: bytes.buffer }, [bytes.buffer]);
  } else {
    self.postMessage({ kind, payload });
  }
}

async function fetchBytes(url, label) {
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
    if (total) status(label, got / total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function syncfs(populate) {
  return new Promise((ok, fail) => py.FS.syncfs(populate, (e) => (e ? fail(e) : ok())));
}

async function boot({ userConfig }) {
  const b = await build;
  status("Starter Python…");
  const index = new URL(b.pyodide_index, self.location).href;  // served with the site
  const { loadPyodide } = await import(`${index}pyodide.mjs`);   // Pyodide 314: module workers only
  py = await loadPyodide({ indexURL: index });

  // ~/.config (mycroft.conf, skill settings) and ~/.local/share (intent
  // cache, skill data) survive reloads, like the disk of a device.
  const home = "/home/pyodide";
  for (const d of [".config", ".local"]) {
    py.FS.mkdirTree(`${home}/${d}`);
    py.FS.mount(py.FS.filesystems.IDBFS, {}, `${home}/${d}`);
  }
  await syncfs(true);

  status("Henter Python-pakker…");
  await py.loadPackage(b.pyodide_packages, { messageCallback: () => {} });

  const bundle = await fetchBytes(b.bundle, "Henter OpenVoiceOS…");
  py.FS.writeFile("/tmp/bundle.zip", bundle);

  const stamp = `${home}/.local/share/emkay-mobile/intent-cache.json`;
  let have = {};
  try { have = JSON.parse(py.FS.readFile(stamp, { encoding: "utf8" })); } catch {}
  for (const [lang, entry] of Object.entries(b.intent_cache || {})) {
    if (have[lang] === entry.hash) continue;
    const zip = await fetchBytes(entry.url, `Henter forudtrænede intents (${lang})…`);
    py.FS.writeFile(`/tmp/intents-${lang}.zip`, zip);
    have[lang] = entry.hash;
  }

  status("Pakker ud…");
  py.globals.set("HAVE_INTENTS", JSON.stringify(have));
  await py.runPythonAsync(`
import glob, json, os, site, sys, zipfile, importlib
sp = site.getsitepackages()[0]
zipfile.ZipFile("/tmp/bundle.zip").extractall(sp)
os.remove("/tmp/bundle.zip")
share = os.path.expanduser("~/.local/share/mycroft")
for z in glob.glob("/tmp/intents-*.zip"):
    zipfile.ZipFile(z).extractall(share)
    os.remove(z)
os.makedirs(os.path.expanduser("~/.local/share/emkay-mobile"), exist_ok=True)
with open(os.path.expanduser("~/.local/share/emkay-mobile/intent-cache.json"), "w") as f:
    f.write(HAVE_INTENTS)
importlib.invalidate_caches()
`);
  py.runPython(`import os; os.environ["EMKAY_TZ"] = ${JSON.stringify(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);

  status("Starter OpenVoiceOS…");
  main = py.pyimport("emkay_mobile.worker_main");
  const info = JSON.parse(main.start(post, userConfig ? py.toPy(userConfig) : null));
  await syncfs(false);
  // keep the disk in step: settings a skill or the setup page writes
  setInterval(() => syncfs(false).catch(() => {}), 10000);
  status("Klar", 1);
  return info;
}

const commands = {
  boot,
  gui_snapshot: () => main.gui_snapshot(),
  gui_message: ({ raw }) => main.gui_message(raw),
  say: ({ text }) => main.say(text),
  record_begin: () => main.record_begin(),
  heard: ({ pcm, rate }) => main.heard(new Uint8Array(pcm), rate),
  playback_started: ({ ident, visemes }) => main.playback_started(ident, JSON.stringify(visemes || [])),
  playback_ended: ({ ident }) => main.playback_ended(ident),
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
