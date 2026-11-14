"""Assemble the static site GitHub Pages serves (build/site/).

  build/site/
    index.html, app.js, worker.js, ...   web/ as is
    bundle-<hash>.zip                    every pure-Python package OVOS needs
                                         (from the wheelhouse), emkay_mobile
                                         and ovos_visage, unpacked into
                                         site-packages by the worker
    intents-<lang>-<hash>.zip            pre-trained padatious cache per language
    build.json                           what to load, for the worker

Usage:
  python3 tools/build_site.py WHEELHOUSE PLAN.json [INTENT_CACHE_DIR ...]
"""
import hashlib
import io
import json
import shutil
import sys
import time
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PYODIDE_VERSION = json.load(open(REPO / "package.json"))["devDependencies"]["pyodide"]
OUT = REPO / "build/site"

SKIP_PARTS = {"__pycache__", "tests", "test"}


def short_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def add_tree(zf, root: Path, arc_root: str):
    for f in sorted(root.rglob("*")):
        if f.is_file() and not SKIP_PARTS & set(f.relative_to(root).parts) and f.suffix != ".pyc":
            zf.write(f, f"{arc_root}/{f.relative_to(root)}")


def build_bundle(wheelhouse: Path, plan: dict) -> bytes:
    buf = io.BytesIO()
    seen = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for name in plan["pure"]:
            with zipfile.ZipFile(wheelhouse / name) as whl:
                for item in whl.infolist():
                    parts = Path(item.filename).parts
                    if item.is_dir() or item.filename in seen or SKIP_PARTS & set(parts[1:]):
                        continue
                    if item.filename.endswith(".pyc"):
                        continue
                    seen.add(item.filename)
                    out.writestr(item.filename, whl.read(item))
        add_tree(out, REPO / "py/emkay_mobile", "emkay_mobile")
        add_tree(out, REPO / "py/ovos_visage", "ovos_visage")
    return buf.getvalue()


def build_intents(cache_dirs):
    """{lang: zip bytes} from build_intent_cache.py output dirs."""
    by_lang = {}
    for d in cache_dirs:
        for cache in sorted(Path(d).glob("intent_cache*")):
            for lang_dir in sorted(p for p in cache.iterdir() if p.is_dir()):
                by_lang.setdefault(lang_dir.name, []).append((cache.name, lang_dir))
    out = {}
    for lang, dirs in by_lang.items():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for cache_name, lang_dir in dirs:
                add_tree(zf, lang_dir, f"{cache_name}/{lang}")
        out[lang] = buf.getvalue()
    return out


def main():
    wheelhouse, plan_path, *cache_dirs = sys.argv[1:]
    plan = json.load(open(plan_path))
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(REPO / "web", OUT)

    bundle = build_bundle(Path(wheelhouse), plan)
    bundle_name = f"bundle-{short_hash(bundle)}.zip"
    (OUT / bundle_name).write_bytes(bundle)

    intents = {}
    for lang, data in build_intents(cache_dirs).items():
        h = short_hash(data)
        name = f"intents-{lang}-{h}.zip"
        (OUT / name).write_bytes(data)
        intents[lang] = {"url": name, "hash": h, "bytes": len(data)}

    versions = sorted(n.split("-")[0] + "==" + n.split("-")[1] for n in plan["pure"])
    build = {
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pyodide_index": f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/",
        "pyodide_packages": plan["pyodide"] + ["micropip"],
        "bundle": bundle_name,
        "bundle_bytes": len(bundle),
        "intent_cache": intents,
        "shimmed": plan["shimmed"],
        "dropped": plan["dropped"],
        "versions": versions,
    }
    (OUT / "build.json").write_text(json.dumps(build, indent=1))
    mb = lambda n: f"{n / 1e6:.1f} MB"
    print(f"site in {OUT}: bundle {mb(len(bundle))}, "
          + ", ".join(f"intents {k} {mb(v['bytes'])}" for k, v in intents.items()))


if __name__ == "__main__":
    main()
