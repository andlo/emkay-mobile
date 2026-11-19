"""Pre-train padatious on a normal CPython, so the browser can skip it.

Padatious trains a small neural net per intent. In WebAssembly that takes
minutes on first boot; on a desktop CPU it takes seconds. The cache it writes
is plain text keyed by a hash of each intent's training lines, so a browser
running the same skill versions loads it instead of training.

The browser has no PyStemmer, and stemming changes the training lines, so
this script trains with the same identity-stemmer stand-in the browser uses.

Usage: python3 tools/build_intent_cache.py OUT_DIR [lang ...]
       (run inside a venv that has the wheelhouse installed)
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]).resolve()
langs = sys.argv[2:] or ["en-US"]

home = tempfile.mkdtemp(prefix="emkay-cache-")
os.environ["HOME"] = home
os.environ["XDG_CONFIG_HOME"] = f"{home}/.config"
os.environ["XDG_DATA_HOME"] = f"{home}/.local/share"
# same stemmer as the browser (identity), so the training lines hash the same
_only_stemmer = tempfile.mkdtemp(prefix="emkay-stemmer-")
os.symlink(REPO / "py/emkay_mobile/shims/Stemmer", Path(_only_stemmer, "Stemmer"))
sys.path.insert(0, _only_stemmer)
sys.path.insert(0, str(REPO / "py"))

# EMKAY_REUSE_CACHE=<dir>: start from an existing cache, to check it is
# actually reused (a valid cache trains nothing and finishes in seconds)
if os.environ.get("EMKAY_REUSE_CACHE"):
    shutil.copytree(os.environ["EMKAY_REUSE_CACHE"], f"{home}/.local/share/mycroft", dirs_exist_ok=True)

if os.environ.get("EMKAY_DIAG"):
    from emkay_mobile import diag  # noqa: E402
    diag.install()

from emkay_mobile import boot  # noqa: E402
# padaos as the browser has it, so the patterns compiled here are the ones
# the browser compiles; tools/re_seed.mjs makes their opcodes (re_cache.py)
from emkay_mobile import padaos_speed, re_cache  # noqa: E402
padaos_speed.install()

trained = threading.Event()


def on_msg(m):
    if '"mycroft.skills.trained"' in m or '"ovos.skills.trained"' in m:
        trained.set()


info = boot.start(on_message=on_msg, user_config={"lang": langs[0], "secondary_langs": langs[1:]})
print(f"loaded {len(info['skills'])} skills in {info['seconds']} s, training...")
t = time.time()
if not trained.wait(int(os.environ.get("EMKAY_TRAIN_WAIT", 1800))):
    if os.environ.get("EMKAY_DIAG"):
        diag.report()
    sys.exit("padatious did not report training finished in time")
print(f"trained in {time.time() - t:.1f} s", flush=True)
if os.environ.get("EMKAY_DIAG"):
    diag.report()

src = Path(home, ".local/share/mycroft")
out.mkdir(parents=True, exist_ok=True)
n = 0
for d in src.glob("intent_cache*"):
    shutil.copytree(d, out / d.name, dirs_exist_ok=True)
    n += sum(1 for _ in (out / d.name).rglob("*") if _.is_file())
# padaos' line regexes' sources, for the browser's first start (padaos_lines.py)
from emkay_mobile import padaos_lines  # noqa: E402
intents = padaos_lines.used()
if intents:
    seed = out / "intent_cache" / langs[0] / padaos_lines.SEED_NAME
    seed.parent.mkdir(parents=True, exist_ok=True)
    padaos_lines.write(intents, seed)
    print(f"{len(intents)} padaos intents' regexes to {seed.relative_to(out)}")
# padaos' patterns, for the browser's first start (re_cache.py, tools/re_seed.mjs)
patterns = re_cache.used_patterns()
if patterns:
    seed = out / "intent_cache" / langs[0] / re_cache.PATTERNS_NAME
    seed.parent.mkdir(parents=True, exist_ok=True)
    seed.write_text(json.dumps(patterns))
    print(f"{len(patterns)} padaos patterns to {seed.relative_to(out)}")
json.dump({"langs": langs, "skills": info["skills"], "files": n},
          open(out / "manifest.json", "w"), indent=1)
print(f"wrote {n} cache files to {out}")
os._exit(0)
