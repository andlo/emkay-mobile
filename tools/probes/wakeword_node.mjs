// Run web/wakeword.js under Node on WAV files and print the wake word scores.
//
//   node tools/probes/wakeword_node.mjs MODEL_DIR MODEL file.wav [file.wav ...]
//   e.g. node tools/probes/wakeword_node.mjs build/oww hey_mycroft_v0.1.onnx hey.wav other.wav
import fs from "fs";
import * as ort from "onnxruntime-web";
import { WakeWord } from "../../web/wakeword.js";

const [dir, model, ...files] = process.argv.slice(2);

/** A mono 16-bit WAV as Int16 samples at 16 kHz (linear resampling). */
function readWav(path) {
  const b = fs.readFileSync(path);
  const rate = b.readUInt32LE(24);
  let o = 12;
  while (b.toString("ascii", o, o + 4) !== "data") o += 8 + b.readUInt32LE(o + 4);
  const n = b.readUInt32LE(o + 4) / 2, src = new Int16Array(n);
  for (let i = 0; i < n; i++) src[i] = b.readInt16LE(o + 8 + i * 2);
  const out = new Int16Array(Math.floor(n * 16000 / rate));
  for (let i = 0; i < out.length; i++) {
    const x = i * rate / 16000, j = Math.floor(x), f = x - j;
    out[i] = Math.round(src[j] * (1 - f) + (src[Math.min(j + 1, n - 1)] || 0) * f);
  }
  return out;
}

const loadModel = (name) => fs.readFileSync(`${dir}/${name}`);
const engine = new WakeWord({
  ...ort,
  InferenceSession: { create: (path) => ort.InferenceSession.create(loadModel(path.split("/").pop())) },
}, "", model);
const t = Date.now();
await engine.load();
console.log(`loaded in ${Date.now() - t} ms`);
for (const f of files) {
  engine.reset();
  const audio = readWav(f);
  const padded = new Int16Array(16000 + audio.length + 16000);   // 1 s of silence around it
  padded.set(audio, 16000);
  let max = 0, at = -1, steps = 0;
  const t0 = Date.now();
  for (let i = 0; i + 1280 <= padded.length; i += 1280) {
    const s = await engine.step(padded.subarray(i, i + 1280));
    steps++;
    if (s > max) { max = s; at = i / 16000; }
  }
  console.log(`${f}: max score ${max.toFixed(3)} at ${at.toFixed(2)} s` +
    ` (${max >= 0.5 ? "DETECTED" : "not heard"}); ${((Date.now() - t0) / steps).toFixed(1)} ms per 80 ms chunk`);
}
