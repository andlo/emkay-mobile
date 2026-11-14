// Boot emkay-mobile's OVOS core in Pyodide under Node and talk to it.
// node tools/node_smoke.mjs <wheel_dir> <plan.json> [utterance ...]
// EMKAY_CACHE=<dir>  pre-trained intent cache (tools/build_intent_cache.py) to load
import { loadPyodide } from "pyodide";
import fs from "fs";
import path from "path";

const [wheelDir, planPath, ...utts] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const py = await loadPyodide({ indexURL: path.join(repo, "node_modules/pyodide") + "/" });
py.setStdout({ batched: (s) => fs.writeSync(1, s + "\n") });
py.setStderr({ batched: (s) => fs.writeSync(2, s + "\n") });
await py.loadPackage(plan.pyodide, { messageCallback: () => {} });

py.FS.mkdirTree("/wheels");
for (const f of plan.pure) py.FS.writeFile("/wheels/" + f, fs.readFileSync(path.join(wheelDir, f)));
function copyDir(src, dst) {
  py.FS.mkdirTree(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === "__pycache__") continue;
    const s = path.join(src, e.name), d = dst + "/" + e.name;
    e.isDirectory() ? copyDir(s, d) : py.FS.writeFile(d, fs.readFileSync(s));
  }
}
copyDir(path.join(repo, "py/emkay_mobile"), "/emkay/emkay_mobile");
if (process.env.EMKAY_CACHE) copyDir(process.env.EMKAY_CACHE, "/home/pyodide/.local/share/mycroft");

py.globals.set("UTTS", py.toPy(utts.length ? utts : ["what time is it", "good morning", "how are you", "what is 2 plus 2"]));
await py.runPythonAsync(`
import os, sys, site, zipfile, time, importlib, json, asyncio
sp = site.getsitepackages()[0]
for f in sorted(os.listdir("/wheels")):
    zipfile.ZipFile("/wheels/" + f).extractall(sp)
importlib.invalidate_caches()
sys.path.insert(0, "/emkay")
os.environ["EMKAY_TZ"] = "Europe/Copenhagen"
t = time.time()
from emkay_mobile import boot
print("import", round(time.time() - t, 2), "s")
from ovos_bus_client.message import Message
heard = []
def on_msg(m):
    m = Message.deserialize(m) if isinstance(m, str) else m
    heard.append(m)
info = boot.start(on_message=on_msg)
print("boot", info["seconds"], "s,", len(info["skills"]), "skills:", ", ".join(info["skills"]))
print("threads:", info["skipped_threads"])
t=time.time(); await asyncio.sleep(0.1); print("training", round(time.time()-t,1), "s")
for u in UTTS:
    heard.clear(); t = time.time()
    boot.utterance(u)
    await asyncio.sleep(1.5)
    spoken = [m.data.get("utterance") for m in heard if m.msg_type in ("speak", "ovos.utterance.speak")]
    matched = [m.msg_type for m in heard if m.msg_type.endswith(".activate")]
    print(f"USER {u!r} -> {spoken} {matched} ({round((time.time()-t)*1000)} ms)")
`);
