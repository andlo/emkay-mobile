// Run a Python file inside Pyodide under Node, with the same packages the
// site ships. For measurements and experiments.
//   node tools/node_run.mjs <wheel_dir> <plan.json> <script.py> [args...]
// The script sees sys.argv[1:] = args, and /emkay on sys.path.
import { loadPyodide } from "pyodide";
import fs from "fs";
import path from "path";

const [wheelDir, planPath, script, ...args] = process.argv.slice(2);
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
copyDir(path.join(repo, "py"), "/emkay");
// host directories the script wants: EMKAY_MOUNT=host_dir:pyodide_dir[,...]
for (const m of (process.env.EMKAY_MOUNT || "").split(",").filter(Boolean)) {
  const [h, p] = m.split(":");
  copyDir(path.resolve(h), p);
}
py.globals.set("ARGS", py.toPy(args));
await py.runPythonAsync(`
import os, sys, site, zipfile, importlib
sp = site.getsitepackages()[0]
for f in sorted(os.listdir("/wheels")):
    zipfile.ZipFile("/wheels/" + f).extractall(sp)
importlib.invalidate_caches()
sys.path.insert(0, "/emkay")
from emkay_mobile import browser
browser.install()
sys.argv = ["script"] + list(ARGS)
`);
await py.runPythonAsync(fs.readFileSync(script, "utf8"));
