// Wake word detection in the browser: openWakeWord's own models and its
// streaming pipeline, run with onnxruntime-web (a Web Worker of its own, so
// listening never holds up the page or OVOS).
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
// As a worker it takes {cmd: "start", model, threshold} and then
// {cmd: "audio", pcm: Int16Array of 1280 samples}, and posts {ready},
// {detected, score} and {error}. The WakeWord class is exported for tests.

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
        const loading = new WakeWord(ort, new URL("oww/", import.meta.url).href, data.model, data.threshold ?? 0.5);
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
