// Wake word detection in the browser, in a Web Worker of its own (listening
// never holds up the page or OVOS), with the engine OVOS' config names for
// the wake word (hotwords.<name>.module), as ovos-dinkum-listener would load
// that plugin:
//
// * ovos-ww-plugin-precise-onnx (OVOS' default for "hey mycroft"): Mycroft
//   Precise models with precise-onnx-js (TigreGotico's port of that
//   plugin's inference: the same MFCCs, ThresholdDecoder and TriggerDetector,
//   so `sensitivity` and `trigger_level` mean what they mean on a device).
//   PreciseEngine below.
// * ovos-ww-plugin-openwakeword: openWakeWord's own models and streaming
//   pipeline (class WakeWord), run with onnxruntime-web:
//
// For every 80 ms of 16 kHz audio (1280 samples), as openwakeword.utils and
// openwakeword.model do it:
//   1. melspectrogram.onnx over the newest 1280 + 480 samples; every value
//      x becomes x / 10 + 2 (openWakeWord's transform)
//   2. embedding_model.onnx over the newest 76 mel frames -> one 96-value
//      embedding
//   3. <wake word>.onnx over the newest 16 embeddings -> a score 0..1
// The first five scores are ignored, as in openWakeWord, while the buffers
// fill. A score at or above the threshold is a detection; then the engine
// rests for a moment so one phrase is not heard twice.
//
// The models: https://github.com/dscripka/openWakeWord (code Apache-2.0,
// pre-trained models CC BY-NC-SA 4.0), fetched at build time
// (tools/fetch_wakeword_models.py).
//
// As a worker it takes {cmd: "start", engine: "precise"|"oww", model,
// threshold (oww), sensitivity and trigger_level (precise)} and then
// {cmd: "audio", pcm: Int16Array of 1280 samples}, and posts {ready},
// {detected, score} and {error}. The engine classes are exported for tests.

const CHUNK = 1280;            // samples per step, 80 ms at 16 kHz
const MEL_CONTEXT = 480;       // samples before the chunk the mel model needs
const MEL_WINDOW = 76;         // mel frames per embedding
const FEATURES = 16;           // embeddings per wake word score
const SKIP_FIRST = 5;          // scores ignored while the buffers fill
const REST_MS = 2000;          // quiet time after a detection

export class WakeWord {
  /**
   * @param {object} ort       onnxruntime-web
   * @param {string} base      URL of the folder with the .onnx files
   * @param {string} model     the wake word model, e.g. "hey_mycroft_v0.1.onnx"
   * @param {number} threshold score that counts as heard (openWakeWord: 0.5)
   */
  constructor(ort, base, model, threshold = 0.5) {
    Object.assign(this, { ort, base, model, threshold });
  }

  async load() {
    const opts = { executionProviders: ["wasm"] };
    const open = (name) => this.ort.InferenceSession.create(`${this.base}${name}`, opts);
    [this.mel, this.emb, this.ww] = await Promise.all(
      [open("melspectrogram.onnx"), open("embedding_model.onnx"), open(this.model)]);
    this.reset();
    // openWakeWord starts its feature buffer from embeddings of noise
    for (let i = 0; i < 50; i++) {
      const noise = new Int16Array(CHUNK).map(() => Math.round(Math.random() * 2000 - 1000));
      await this.step(noise, false);
    }
    this.scores = 0;
  }

  reset() {
    this.raw = new Float32Array(MEL_CONTEXT + CHUNK);
    this.melFrames = Array.from({ length: MEL_WINDOW }, () => new Float32Array(32).fill(1));
    this.features = [];
    this.scores = 0;
    this.restUntil = 0;
  }

  /**
   * One 1280-sample chunk of 16 kHz audio in; the wake word score out (0
   * while the buffers fill or while resting after a detection).
   */
  async step(pcm, score = true) {
    const T = this.ort.Tensor;
    // 1. mel frames of the newest samples (as float, not scaled: int16 values)
    this.raw.copyWithin(0, CHUNK);
    for (let i = 0; i < CHUNK; i++) this.raw[MEL_CONTEXT + i] = pcm[i];
    const melOut = await this.mel.run({ [this.mel.inputNames[0]]: new T("float32", this.raw.slice(), [1, this.raw.length]) });
    const spec = melOut[this.mel.outputNames[0]];
    const frames = spec.dims[spec.dims.length - 2], bins = spec.dims[spec.dims.length - 1];
    for (let f = 0; f < frames; f++) {
      const row = new Float32Array(bins);
      for (let b = 0; b < bins; b++) row[b] = spec.data[f * bins + b] / 10 + 2;
      this.melFrames.push(row);
    }
    this.melFrames.splice(0, this.melFrames.length - MEL_WINDOW);
    // 2. one embedding of the newest 76 frames
    const window = new Float32Array(MEL_WINDOW * 32);
    this.melFrames.forEach((row, i) => window.set(row, i * 32));
    const embOut = await this.emb.run({ [this.emb.inputNames[0]]: new T("float32", window, [1, MEL_WINDOW, 32, 1]) });
    this.features.push(Float32Array.from(embOut[this.emb.outputNames[0]].data));
    this.features.splice(0, this.features.length - FEATURES);
    if (!score || this.features.length < FEATURES) return 0;
    // 3. the wake word score of the newest 16 embeddings
    const feats = new Float32Array(FEATURES * 96);
    this.features.forEach((f, i) => feats.set(f, i * 96));
    const wwOut = await this.ww.run({ [this.ww.inputNames[0]]: new T("float32", feats, [1, FEATURES, 96]) });
    const s = wwOut[this.ww.outputNames[0]].data[0];
    if (++this.scores <= SKIP_FIRST || Date.now() < this.restUntil) return 0;
    if (s >= this.threshold) this.restUntil = Date.now() + REST_MS;
    return s;
  }
}

// ------------------------------------------------------------- Precise
/**
 * ovos-ww-plugin-precise-onnx in the browser: precise-onnx-js (vendored in
 * oww/precise/, see tools/fetch_wakeword_models.py), fed Precise's 2048-
 * sample chunks. Its TriggerDetector does what the plugin's does: a chunk
 * counts when the calibrated score is above 1 - sensitivity, a detection
 * needs more than trigger_level such chunks in a row, and after one it
 * stays deaf for a moment.
 */
export class PreciseEngine {
  constructor(ort, base, model, sensitivity = 0.5, triggerLevel = 3) {
    Object.assign(this, { ort, base, model, sensitivity, triggerLevel });
    this.pending = new Float32Array(0);
  }

  async load() {
    // precise-onnx-js is written as plain scripts (CommonJS or <script>
    // globals); run them as such and take what they define
    const lib = async (name, names) => {
      const src = await (await fetch(`${this.base}${name}`)).text();
      // eslint-disable-next-line no-new-func
      return new Function(`${src}\nreturn { ${names.join(", ")} };`)();
    };
    const { mfccSpec } = await lib("mfcc.js", ["mfccSpec"]);
    globalThis.mfccSpec = mfccSpec;
    globalThis.ort = this.ort;
    const { PreciseOnnxWakeWord } = await lib("wakeword.js", ["PreciseOnnxWakeWord"]);
    const session = await this.ort.InferenceSession.create(this.model, { executionProviders: ["wasm"] });
    this.ww = new PreciseOnnxWakeWord(session, session.inputNames[0], this.sensitivity, this.triggerLevel);
    this.threshold = 0.5;   // detections are 1, misses their score (below)
  }

  reset() {
    this.ww?.clear();
    this.pending = new Float32Array(0);
  }

  /** 1280 Int16 samples in; 1 when the wake word was heard, else the last score. */
  async step(pcm) {
    const more = new Float32Array(this.pending.length + pcm.length);
    more.set(this.pending);
    for (let i = 0; i < pcm.length; i++) more[this.pending.length + i] = pcm[i] / 32768;
    this.pending = more;
    let heard = false, score = 0;
    while (this.pending.length >= 2048) {
      const chunk = this.pending.slice(0, 2048);
      this.pending = this.pending.slice(2048);
      score = await this.ww.update(chunk);
      if (this.ww.triggerDetector.update(score)) heard = true;
    }
    return heard ? 1 : Math.min(score, 0.49);
  }
}

// ------------------------------------------------------------- the worker
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  let engine = null;
  let busy = Promise.resolve();
  self.onmessage = async ({ data }) => {
    try {
      if (data.cmd === "start") {
        const ort = await import(new URL("ort/ort.wasm.bundle.min.mjs", import.meta.url).href);
        ort.env.wasm.wasmPaths = new URL("ort/", import.meta.url).href;
        ort.env.wasm.numThreads = 1;   // the page is not cross-origin isolated
        const loading = data.engine === "precise"
          ? new PreciseEngine(ort, new URL("oww/precise/", import.meta.url).href,
            new URL(data.model, import.meta.url).href, data.sensitivity ?? 0.5, data.trigger_level ?? 3)
          : new WakeWord(ort, new URL("oww/", import.meta.url).href, data.model, data.threshold ?? 0.5);
        await loading.load();
        engine = loading;   // audio that came while loading is dropped, not run alongside
        self.postMessage({ ready: true });
      } else if (data.cmd === "audio" && engine) {
        // one chunk at a time, in order; a failing chunk is reported and
        // the next ones still run (a rejected chain would skip them all)
        busy = busy.then(async () => {
          const score = await engine.step(data.pcm);
          if (score >= engine.threshold) self.postMessage({ detected: true, score });
          else if (score >= 0.05) self.postMessage({ score });   // near misses, for diagnostics
        }).catch((e) => self.postMessage({ error: e.message || String(e) }));
      } else if (data.cmd === "reset" && engine) {
        engine.reset();
      }
    } catch (e) {
      self.postMessage({ error: e.message || String(e) });
    }
  };
}
