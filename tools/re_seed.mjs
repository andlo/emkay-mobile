// padaos' regexes for a browser's first start (#4, py/emkay_mobile/re_cache.py).
//
// tools/build_intent_cache.py leaves the patterns padaos compiled, as
// intent_cache*/<lang>/re-patterns.json. Their opcodes are not the same on
// 64-bit CPython as in WebAssembly, so they are compiled again here, in the
// Pyodide the site ships, into re-cache.marshal next to them (which the
// worker unpacks with the rest of the intent cache), and the .json goes.
//
//   node tools/re_seed.mjs <dir> [<dir> ...]     the build_intent_cache.py outputs
import { loadPyodide } from "pyodide";
import fs from "fs";
import path from "path";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const found = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "re-patterns.json") found.push(p);
  }
};
for (const d of process.argv.slice(2)) walk(d);
if (!found.length) { console.log("re_seed: no re-patterns.json"); process.exit(0); }

const py = await loadPyodide({ indexURL: path.join(repo, "node_modules/pyodide") + "/" });
py.FS.mkdirTree("/emkay/emkay_mobile");
py.FS.writeFile("/emkay/emkay_mobile/__init__.py", "");
py.FS.writeFile("/emkay/emkay_mobile/re_cache.py",
  fs.readFileSync(path.join(repo, "py/emkay_mobile/re_cache.py")));
py.runPython("import sys; sys.path.insert(0, '/emkay'); from emkay_mobile import re_cache");
const writeSeed = py.globals.get("re_cache").write_seed;
for (const f of found) {
  const t = Date.now();
  py.FS.writeFile("/tmp/patterns.json", fs.readFileSync(f));
  const n = writeSeed(py.runPython("import json; json.load(open('/tmp/patterns.json'))"), "/tmp/seed.marshal");
  const out = path.join(path.dirname(f), "re-cache.marshal");
  fs.writeFileSync(out, py.FS.readFile("/tmp/seed.marshal"));
  fs.rmSync(f);
  console.log(`re_seed: ${n} regexes, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ` +
    `in ${((Date.now() - t) / 1000).toFixed(0)} s: ${out}`);
}
