// Emkay – a HiveMind client in plain JavaScript (issue #11).
//
// Speaks the HiveMind protocol to a hivemind-core over a WebSocket, the way
// hivemind-bus-client does in Python, with the browser's own WebCrypto, so
// a satellite needs no Pyodide. Runs in a browser and in Node 22+ (global
// WebSocket and crypto.subtle) – tools/probes/hivemind_node.mjs tests it
// against a real hivemind-core.
//
// The protocol, as hivemind-core 4 / hivemind-bus-client 0.4 speak it:
//   1. connect to ws(s)://host:port?authorization=base64("useragent:accessKey")
//   2. server → HELLO {pubkey, peer, node_id}
//   3. server → HANDSHAKE {password: true, encodings, ciphers, ...}
//   4. client → HANDSHAKE {envelope, encodings, ciphers, binarize}
//        envelope = hex(iv8 + sha256(iv8 + password))[:48]   (poorman_handshake)
//   5. server → HANDSHAKE {envelope, encoding, cipher}
//        salt = our iv XOR their iv; key = PBKDF2-SHA256(password, salt, 100000) → 32 bytes
//   6. from here on every frame is {"ciphertext","tag","nonce"} (AES-GCM,
//      16-byte nonce, 16-byte tag), each field in the agreed encoding
//   7. client → HELLO {session, site_id}   (encrypted)
//   8. both ways: {msg_type: "bus", payload: <OVOS message>}
//
// Only the password handshake (protocol V1), AES-GCM and JSON-B64/JSON-HEX
// are done here: that is what a stock hivemind-core offers a new client.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------- encodings
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
function toB64(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const CODECS = {
  "JSON-B64": [toB64, fromB64],
  "JSON-HEX": [toHex, fromHex],
};
/** Encodings and ciphers we offer, in the order we prefer them. */
export const ENCODINGS = Object.keys(CODECS);
export const CIPHERS = ["AES-GCM"];

const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

// ------------------------------------------------- password handshake
/** poorman_handshake's hSub: hex(iv + sha256(iv + text)), cut to `len` digits. */
async function hsub(text, iv, len = 48) {
  const hash = new Uint8Array(await subtle.digest("SHA-256", concat(iv, enc.encode(text))));
  return toHex(concat(iv, hash)).slice(0, len);
}

/** Does the server's envelope prove it knows the password too? */
async function matches(envelope, password) {
  if (envelope.length < 48 || envelope.length > 80) return false;
  return (await hsub(password, fromHex(envelope.slice(0, 16)), envelope.length)) === envelope;
}

async function deriveKey(password, salt) {
  const base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// ------------------------------------------------------------ the client
/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=5678]
 * @param {boolean} [opts.ssl=true]  wss:// – an https page can't open ws:// on the LAN
 * @param {string} opts.key          access key from `hivemind-core add-client`
 * @param {string} opts.password     its password
 * @param {string} [opts.siteId]
 * @param {string} [opts.sessionId]  must not be "default"
 * @param {string} [opts.lang]
 * @param {string} [opts.useragent="Emkay"]
 */
export class HiveMindClient extends EventTarget {
  constructor(opts) {
    super();
    this.opts = { port: 5678, ssl: true, useragent: "Emkay", siteId: "emkay", lang: "en-US", ...opts };
    this.opts.sessionId ||= globalThis.crypto.randomUUID();
    if (this.opts.sessionId === "default") throw new Error('session "default" is for admins');
    this.key = null;        // CryptoKey once the handshake is done
    this.encoding = "JSON-HEX";
    this.peer = null;       // how the server knows us
    this.nodeId = null;     // the server's name
    this.ws = null;
    this._iv = null;
  }

  get url() {
    const { host, port, ssl, useragent, key } = this.opts;
    const auth = btoa(`${useragent}:${key}`);
    return `${ssl ? "wss" : "ws"}://${host}:${port}?authorization=${encodeURIComponent(auth)}`;
  }

  /** Connect and finish the handshake; resolves when bus messages can flow. */
  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("HiveMind handshake timed out")), timeoutMs);
      const fail = (e) => { clearTimeout(timer); this.close(); reject(e); };
      this._ready = () => { clearTimeout(timer); resolve(this); };
      this._fail = fail;
      this.ws = new WebSocket(this.url);
      this.ws.onmessage = (ev) => this._receive(ev.data).catch((e) => this._fail?.(e));
      this.ws.onerror = () => this._fail?.(new Error(`can't reach ${this.opts.host}:${this.opts.port}`));
      this.ws.onclose = (ev) => {
        const wasReady = !!this.key;
        this.key = null;
        if (!wasReady) this._fail?.(new Error(`HiveMind closed the connection (${ev.code}) – wrong key or password?`));
        this.dispatchEvent(Object.assign(new Event("close"), { code: ev.code }));
      };
    });
  }

  close() {
    this._fail = null;
    try { this.ws?.close(); } catch {}
  }

  /** Send an OVOS bus message to the hive. */
  async emit(type, data = {}, context = {}) {
    const ctx = {
      source: this.peer || "emkay", destination: "HiveMind",
      session: { session_id: this.opts.sessionId, lang: this.opts.lang, site_id: this.opts.siteId },
      ...context,
    };
    await this._send({ msg_type: "bus", payload: { type, data, context: ctx } });
  }

  async _send(hive) {
    const msg = { metadata: {}, route: [], node: null, target_site_id: null, target_pubkey: null,
                  source_peer: null, ...hive };
    const text = JSON.stringify(msg);
    if (!this.key) return this.ws.send(text);   // only the handshake goes in the clear
    const nonce = random(16);
    const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 },
      this.key, enc.encode(text)));
    const [encode] = CODECS[this.encoding];
    this.ws.send(JSON.stringify({
      ciphertext: encode(sealed.subarray(0, sealed.length - 16)),
      tag: encode(sealed.subarray(sealed.length - 16)),
      nonce: encode(nonce),
    }));
  }

  async _open(frame) {
    const [, decode] = CODECS[this.encoding];
    const sealed = concat(decode(frame.ciphertext), frame.tag ? decode(frame.tag) : new Uint8Array());
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: decode(frame.nonce), tagLength: 128 },
      this.key, sealed);
    return JSON.parse(dec.decode(plain));
  }

  async _receive(raw) {
    if (typeof raw !== "string") raw = dec.decode(raw instanceof Blob ? await raw.arrayBuffer() : raw);
    let msg = JSON.parse(raw);
    if (msg.ciphertext) {
      if (!this.key) throw new Error("encrypted message before the handshake");
      msg = await this._open(msg);
    }
    switch (msg.msg_type) {
      case "hello": return this._hello(msg.payload);
      case "shake": return this._shake(msg.payload);
      case "bus": return this._bus(msg.payload);
      default:
        this.dispatchEvent(Object.assign(new Event("hive"), { message: msg }));
    }
  }

  _hello(p) {
    if (this.nodeId) return;   // other nodes may say HELLO later; the first one is the server
    this.nodeId = p.node_id || "";
    this.peer = p.peer || null;
  }

  async _shake(p) {
    if (!p.envelope) {
      // the server asks us to start
      if (!p.password) throw new Error("this hivemind-core offers no password handshake");
      this._iv = random(8);
      await this._send({ msg_type: "shake", payload: {
        binarize: false, encodings: ENCODINGS, ciphers: CIPHERS,
        envelope: await hsub(this.opts.password, this._iv),
      } });
      return;
    }
    // the server's answer
    if (!(await matches(p.envelope, this.opts.password))) throw new Error("HiveMind's answer doesn't match the password");
    if (p.cipher && !CIPHERS.includes(p.cipher)) throw new Error(`cipher ${p.cipher} not supported`);
    if (p.encoding && !CODECS[p.encoding]) throw new Error(`encoding ${p.encoding} not supported`);
    this.encoding = p.encoding || "JSON-HEX";
    const theirs = fromHex(p.envelope.slice(0, 16));
    const salt = this._iv.map((b, i) => b ^ theirs[i]);
    this.key = await deriveKey(this.opts.password, salt);
    await this._send({ msg_type: "hello", payload: {
      session: { session_id: this.opts.sessionId, lang: this.opts.lang, site_id: this.opts.siteId },
      site_id: this.opts.siteId,
    } });
    this._fail = null;
    this._ready?.();
  }

  _bus(payload) {
    const message = typeof payload === "string" ? JSON.parse(payload) : payload;
    this.dispatchEvent(Object.assign(new Event("message"), { message }));
  }
}
