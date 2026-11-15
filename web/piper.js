// Emkay – Piper text-to-speech in the browser (issue #3).
//
// Piper (rhasspy) voices are VITS models in ONNX; a device runs them with
// onnxruntime and phonemizes the text with espeak-ng (piper-phonemize).
// Here both run in the Pyodide worker, as WebAssembly:
//   * piper-phonemize compiled to wasm (@diffusionstudio/piper-wasm, MIT;
//     it carries espeak-ng's data), served from piper/ on this site
//   * onnxruntime-web, which Emkay already ships for the wake word (ort/)
//   * the voice itself, from rhasspy's piper-voices on Hugging Face, only
//     when that voice is chosen, and kept in the Cache API afterwards
// The OVOS side is emkay_mobile/tts_piper.py (ovos-tts-plugin-piper-browser),
// which calls synth() through JSPI and gets a WAV back, as a device's
// ovos-tts-plugin-piper writes one.

const BASE = new URL("./", import.meta.url).href;
const VOICES = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
const CACHE = "emkay-piper-v1";

let ortReady = null;        // onnxruntime-web
let phonemizer = null;      // {create, wasm, data}
const sessions = new Map(); // voice -> Promise<{cfg, session}>
const loaded = new Set();    // voices whose session is ready

/** Bytes of `url`, from the Cache API when we have them. */
async function cached(url) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  let res = cache && (await cache.match(url));
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    if (cache) await cache.put(url, res.clone()).catch(() => {});
  }
  return new Uint8Array(await res.arrayBuffer());
}

function ort() {
  ortReady ??= import(BASE + "ort/ort.wasm.bundle.min.mjs").then((m) => {
    const o = m.default ?? m;
    o.env.wasm.numThreads = 1;              // no cross-origin isolation here
    o.env.wasm.wasmPaths = BASE + "ort/";
    return o;
  });
  return ortReady;
}

/** piper-phonemize: the Emscripten factory, its wasm and its espeak-ng data. */
async function loadPhonemizer() {
  if (!phonemizer) {
    phonemizer = (async () => {
      const [src, wasm, data] = await Promise.all([
        fetch(BASE + "piper/piper_phonemize.js").then((r) => r.text()),
        cached(BASE + "piper/piper_phonemize.wasm"),
        cached(BASE + "piper/piper_phonemize.data"),
      ]);
      // a classic script that defines createPiperPhonemize; this is a module worker
      const create = new Function(`${src}\nreturn createPiperPhonemize;`)();
      return { create, wasm, data };
    })();
  }
  return phonemizer;
}

/** Phoneme ids for each sentence of `text`, as piper-phonemize gives them. */
async function phonemeIds(text, espeakVoice) {
  const { create, wasm, data } = await loadPhonemizer();
  const lines = [];
  const mod = await create({
    noInitialRun: true,
    wasmBinary: wasm,
    // the espeak-ng data package, from our cache instead of a new download
    getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    locateFile: (name) => BASE + "piper/" + name,
    print: (line) => lines.push(line),
    printErr: (line) => console.warn("[piper] phonemize:", line),
  });
  mod.callMain(["-l", espeakVoice, "--input", JSON.stringify([{ text }]),
    "--espeak_data", "/espeak-ng-data"]);
  return lines.map((l) => JSON.parse(l).phoneme_ids).filter((ids) => ids?.length);
}

/** Where a voice lives in piper-voices: da_DK-talesyntese-medium -> da/da_DK/talesyntese/medium/... */
function voicePath(voice) {
  const parts = voice.split("-");
  const code = parts[0], quality = parts.at(-1), speaker = parts.slice(1, -1).join("-");
  return `${code.split("_")[0]}/${code}/${encodeURIComponent(speaker)}/${quality}/${encodeURIComponent(voice)}`;
}

function session(voice) {
  if (!sessions.has(voice)) {
    const p = (async () => {
      const o = await ort();
      const url = VOICES + voicePath(voice) + ".onnx";
      const [cfgBytes, model] = await Promise.all([cached(url + ".json"), cached(url)]);
      const cfg = JSON.parse(new TextDecoder().decode(cfgBytes));
      const s = await o.InferenceSession.create(model, { executionProviders: ["wasm"] });
      await loadPhonemizer();
      loaded.add(voice);
      return { cfg, session: s };
    })();
    p.catch(() => sessions.delete(voice));   // a failed download is tried again next time
    sessions.set(voice, p);
  }
  return sessions.get(voice);
}

/**
 * Whether `voice` can speak right away. If not, its download starts (once)
 * and false is returned: the first download is tens of megabytes, and OVOS
 * should not stay silent meanwhile (tts_piper.py then lets the fallback
 * TTS speak).
 */
export function ready(voice) {
  if (loaded.has(voice)) return true;
  session(voice).catch((e) => console.warn(`[piper] ${voice} could not be loaded:`, e));
  return false;
}

/** 16-bit mono WAV of float samples. */
function wav(samples, rate) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true);
  out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, samples.length * 2, true);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const gain = peak > 1 ? 1 / peak : 1;   // as piper: no clipping
  samples.forEach((s, i) => out.setInt16(44 + i * 2, Math.round(s * gain * 32767), true));
  return new Uint8Array(out.buffer);
}

/**
 * Speak `text` with `voice` (a piper-voices name, e.g. "en_US-lessac-medium").
 * Returns a WAV as a Uint8Array. The first call for a voice downloads it.
 */
export async function synth(text, voice, speaker = 0) {
  const t = performance.now();
  const [{ cfg, session: s }, o] = await Promise.all([session(voice), ort()]);
  const rate = cfg.audio.sample_rate;
  const { noise_scale, length_scale, noise_w } = cfg.inference;
  const pcm = [];
  const pause = new Float32Array(Math.round(rate * 0.2));   // between sentences
  for (const ids of await phonemeIds(text, cfg.espeak.voice)) {
    const feeds = {
      input: new o.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new o.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new o.Tensor("float32", Float32Array.from([noise_scale, length_scale, noise_w]), [3]),
    };
    if (cfg.num_speakers > 1) feeds.sid = new o.Tensor("int64", BigInt64Array.from([BigInt(speaker)]), [1]);
    const { output } = await s.run(feeds);
    if (pcm.length) pcm.push(pause);
    pcm.push(output.data);
  }
  const all = new Float32Array(pcm.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of pcm) { all.set(p, off); off += p.length; }
  console.log(`[piper] ${voice}: ${(all.length / rate).toFixed(1)} s of speech in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  return wav(all, rate);
}
