// Emkay – the network log: every request the worker makes, and who made it.
//
// All of Emkay's own traffic goes through this worker: Python's requests,
// urllib and httpx (pyodide-http: XMLHttpRequest and fetch), and the page's
// own downloads in it (speech models, Piper voices, wake words, the site's
// files). So wrapping fetch and XMLHttpRequest here sees all of it. Python
// says which skill or plugin is calling right before each request
// (py/emkay_mobile/netlog.py sets `emkayNetCaller`); without it the caller is
// Emkay itself.
//
// What is kept, per request: when, the host, the method, the status, the
// size of the answer, who asked and what the service is (kind and words). Never the path,
// the query or the body: a translate server, for one, has the sentence in
// its address, and the log must not become what it is there to show.
//
// The log is a file on the phone, ~/.local/state/emkay/network.jsonl (one
// JSON object per line), in the IndexedDB-backed ~/.local like the rest of
// OVOS' data, so a skill can read it too (ovos-skill-outbound-report). Only
// the last DAYS days are kept. Format: docs/network-log.md.

const FILE = "/home/pyodide/.local/state/emkay/network.jsonl";
const DAYS = 7;

/** Known services, by host: [pattern, kind, words]. `kind` is a fixed id the
 * menu and skills translate; the words are English, for anything else. */
const SERVICES = [
  [/(^|\.)stt\.openvoiceos\.pt$|(^|\.)stt\.smartgic\.io$/, "stt", "speech recognition (OpenVoiceOS server)"],
  [/(^|\.)tts\.openvoiceos\.pt$|(^|\.)tts\.smartgic\.io$/, "tts", "voice (OpenVoiceOS server)"],
  [/nllb|translat/, "translate", "translation (OpenVoiceOS server)"],
  [/(^|\.)wikipedia\.org$|(^|\.)wikimedia\.org$|(^|\.)wikidata\.org$/, "wikipedia", "Wikipedia"],
  [/(^|\.)huggingface\.co$|(^|\.)hf\.co$|xethub/, "models", "model downloads (Hugging Face)"],
  [/(^|\.)store\.emkay\.ai$/, "store", "Emkay skill store"],
  [/(^|\.)pypi\.org$|(^|\.)pythonhosted\.org$/, "packages", "package installs (PyPI)"],
  [/(^|\.)jsdelivr\.net$/, "pyodide", "Pyodide packages"],
  [/(^|\.)githubusercontent\.com$|(^|\.)github\.com$/, "github", "GitHub"],
  [/(^|\.)openstreetmap\.org$/, "maps", "maps (OpenStreetMap)"],
  [/(^|\.)open-meteo\.com$|weather/, "weather", "weather"],
  [/radio-browser|somafm|(^|\.)dr\.dk$|stream/, "radio", "radio and news"],
];

// "Local only" (py/emkay_mobile/local_only.py): every request is refused
// but Emkay's own site and GET downloads of models and voices (the local
// speech recognition and voice need them once). Refused requests are logged
// as such (status 0, "blocked": true).
let localOnly = false;
const ALLOWED_KINDS = new Set(["self", "models"]);

/** Switch "local only" (called from Python through emkayNet). */
export function setLocalOnly(on) { localOnly = !!on; }
export function isLocalOnly() { return localOnly; }

function blocked(url, method) {
  if (!localOnly) return false;
  let host;
  try { host = new URL(url, self.location.href).host; } catch { return false; }
  if (url.startsWith("data:") || url.startsWith("blob:")) return false;
  const [kind] = service(host);
  return !(ALLOWED_KINDS.has(kind) && (kind === "self" || (method || "GET").toUpperCase() === "GET"));
}

let fs = null;            // Pyodide's FS, once ~/.local is mounted
let sink = null;          // in the speech worker: where entries go instead
let pending = [];          // entries not written yet
let pruned = false;

/** [kind, words] for a host: a known service, Emkay's own site, or the host itself. */
export function service(host) {
  if (host === self.location.host) return ["self", "Emkay itself (this site)"];
  for (const [re, kind, name] of SERVICES) if (re.test(host)) return [kind, name];
  return ["other", host];
}

function record(url, method, status, bytes, caller, refused = false) {
  let host;
  try { host = new URL(url, self.location.href).host; } catch { return; }
  if (!host || url.startsWith("data:") || url.startsWith("blob:")) return;
  const [kind, name] = service(host);
  (sink ?? add)({
    t: Date.now(), host, method: (method || "GET").toUpperCase(),
    status: status || 0, bytes: Number.isFinite(bytes) ? bytes : null,
    who: caller || "emkay", service: name, kind, ...(refused ? { blocked: true } : {}),
  });
}

/** Who is asking now: what Python said, else Emkay itself. */
const caller = () => globalThis.emkayNetCaller || null;

function wrapFetch() {
  const plain = self.fetch.bind(self);
  self.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const method = init.method || input?.method || "GET";
    const who = caller();
    if (blocked(url, method)) {
      record(url, method, 0, null, who, true);
      throw new TypeError("Emkay is in local only mode: this request was not sent");
    }
    try {
      const r = await plain(input, init);
      const len = Number(r.headers.get("content-length"));
      record(url, method, r.status, Number.isFinite(len) && len > 0 ? len : null, who);
      return r;
    } catch (e) {
      record(url, method, 0, null, who);   // blocked (CORS) or offline
      throw e;
    }
  };
}

function wrapXHR() {
  const proto = XMLHttpRequest.prototype;
  const open = proto.open, send = proto.send;
  proto.open = function (method, url, async = true, ...rest) {
    this._emkay = { method, url: String(url), async, who: caller() };
    return open.call(this, method, url, async, ...rest);
  };
  const done = (xhr) => {
    const m = xhr._emkay;
    if (!m || m.logged) return;
    m.logged = true;
    let bytes = null;
    try {
      if (xhr.responseType === "" || xhr.responseType === "text") bytes = xhr.responseText.length;
      else if (xhr.response?.byteLength != null) bytes = xhr.response.byteLength;
    } catch {}
    record(m.url, m.method, xhr.status, bytes, m.who);
  };
  proto.send = function (...args) {
    const m = this._emkay;
    if (m && blocked(m.url, m.method)) {
      m.logged = true;
      record(m.url, m.method, 0, null, m.who, true);
      throw new DOMException("Emkay is in local only mode: this request was not sent", "NetworkError");
    }
    if (this._emkay?.async) this.addEventListener("loadend", () => done(this));
    try {
      return send.apply(this, args);
    } finally {
      if (this._emkay && !this._emkay.async) done(this);   // synchronous (pyodide-http)
    }
  };
}

function lines(text) {
  return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function readFile() {
  try { return fs.readFile(FILE, { encoding: "utf8" }); } catch { return ""; }
}

/** Write what is pending (appended); the first time, drop entries older than DAYS. */
function flush() {
  if (!fs) return;
  try {
    fs.mkdirTree(FILE.slice(0, FILE.lastIndexOf("/")));
    const add = pending.map((e) => JSON.stringify(e) + "\n").join("");
    pending = [];
    if (!pruned) {
      pruned = true;
      const since = Date.now() - DAYS * 864e5;
      const kept = lines(readFile()).filter((e) => e.t >= since).map((e) => JSON.stringify(e) + "\n");
      fs.writeFile(FILE, kept.join("") + add);
    } else if (add) {
      const bytes = new TextEncoder().encode(add);
      const stream = fs.open(FILE, "a");
      try { fs.write(stream, bytes, 0, bytes.length); } finally { fs.close(stream); }
    }
  } catch (e) {
    console.warn("[emkay] network log", e);
  }
}

/**
 * Start logging: wraps fetch and XMLHttpRequest in this worker. In the
 * speech worker (speech-worker.js) `sink` gets each entry, which worker.js
 * add()s to its own log.
 */
export function install(options = {}) {
  sink = options.sink || null;
  wrapFetch();
  wrapXHR();
  if (!sink) setInterval(flush, 5000);
}

/** An entry made in another worker (the speech worker). */
export function add(entry) {
  pending.push(entry);
}

/** Pyodide's FS, once ~/.local is mounted: entries from now on go to the file. */
export function attach(pyFS) {
  fs = pyFS;
  flush();
}

/** All entries, oldest first (the file and what is not written yet). */
export function entries() {
  flush();
  return [...(fs ? lines(readFile()) : []), ...pending];
}

/** Forget everything. */
export function clear() {
  pending = [];
  if (fs) try { fs.writeFile(FILE, ""); } catch {}
}
