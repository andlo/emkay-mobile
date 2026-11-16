"""Assemble the static site GitHub Pages serves (build/site/).

  build/site/
    index.html, app.js, worker.js, ...   web/ as is
    texts.json                           Emkay's own texts, from locale/<lang>/*.dialog
    bundle-<hash>.zip                    every pure-Python package OVOS needs
                                         (from the wheelhouse) and emkay_mobile,
                                         unpacked into site-packages by the worker
    intents-<lang>-<hash>.zip            pre-trained padatious cache per language
    build.json                           what to load, for the worker

Usage:
  python3 tools/build_site.py WHEELHOUSE PLAN.json [INTENT_CACHE_DIR ...]
  (EMKAY_M2V=<dir from tools/fetch_m2v_models.py> adds the m2v models,
   EMKAY_OWW=<dir from tools/fetch_wakeword_models.py> the wake word models;
   onnxruntime-web, which runs them, comes from node_modules)
"""
import hashlib
import io
import os
import re
import urllib.error
import urllib.request
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
PYODIDE_CORE = ["pyodide.js", "pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm",
                "python_stdlib.zip", "pyodide-lock.json"]
PYODIDE_CDN = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/"


def norm(n):
    return re.sub(r"[-_.]+", "-", n).lower()


def vendor_pyodide(packages):
    """Copy Pyodide and the packages OVOS needs into the site.

    Served from the same origin, so the app does not depend on a CDN, works
    offline once cached, and needs no cross-origin requests from the worker.
    """
    src = REPO / "node_modules/pyodide"
    dst = OUT / "pyodide"
    dst.mkdir(parents=True)
    for f in PYODIDE_CORE:
        shutil.copy(src / f, dst / f)
    lock = json.load(open(src / "pyodide-lock.json"))["packages"]
    by_norm = {norm(k): v for k, v in lock.items()}
    need, todo = set(), [norm(p) for p in packages]
    while todo:
        n = todo.pop()
        if n in need:
            continue
        need.add(n)
        todo += [norm(d) for d in by_norm[n].get("depends", [])]
    cache = REPO / "build/pyodide-cache"
    cache.mkdir(parents=True, exist_ok=True)
    total = 0
    for n in sorted(need):
        fn = by_norm[n]["file_name"]
        if not (cache / fn).exists():
            fetch(PYODIDE_CDN + fn, cache / fn)
        shutil.copy(cache / fn, dst / fn)
        total += (dst / fn).stat().st_size
    return sorted(need), total


def fetch(url: str, dest: Path, tries: int = 5):
    """Download url to dest, retrying when the server has a bad moment.

    The Pyodide CDN now and then answers 503 ("No healthy backends") for a
    few minutes; one such answer used to fail the whole site build. The
    file goes to a .part name first, so a broken download never sits in the
    cache looking finished.
    """
    part = dest.with_name(dest.name + ".part")
    for n in range(1, tries + 1):
        try:
            urllib.request.urlretrieve(url, part)
            part.replace(dest)
            return
        except (urllib.error.URLError, OSError) as e:
            if n == tries:
                raise
            wait = 10 * n
            print(f"  {url}: {e}; trying again in {wait} s", flush=True)
            time.sleep(wait)


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
        add_shim_distributions(out, plan["shimmed"])
    return buf.getvalue()


def add_shim_distributions(zf, shimmed):
    """A .dist-info next to the stand-ins (emkay_mobile/shims) for each
    native package they replace, with the version this site was built with.

    Then importlib.metadata finds them, so a skill installed later that
    requires rapidfuzz, psutil, ... finds the requirement met (pip.py), and
    the control panel lists them, the same as for the packages in the
    bundle. INSTALLER says where they come from.
    """
    for wheel in shimmed:
        name, version = wheel.split("-")[:2]
        info = f"emkay_mobile/shims/{name}-{version}.dist-info"
        zf.writestr(f"{info}/METADATA", (
            "Metadata-Version: 2.1\n"
            f"Name: {name}\n"
            f"Version: {version}\n"
            f"Summary: Emkay's pure-Python stand-in for {name}, which has no "
            "WebAssembly build (emkay_mobile/shims)\n"))
        zf.writestr(f"{info}/INSTALLER", "emkay-shim\n")
        zf.writestr(f"{info}/RECORD", "")


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


def locale_texts() -> dict:
    """Emkay's own texts: {lang: {key: text}} from locale/<lang>/<key>.dialog.

    The same layout and format as an OVOS skill's dialogs (one file per
    text, {placeholders}), so translation tools for skills read them too.
    The first line of a file is the text.
    """
    out = {}
    for d in sorted((REPO / "locale").iterdir()):
        if d.is_dir():
            out[d.name] = {f.name[:-len(".dialog")]: f.read_text(encoding="utf-8").splitlines()[0].strip()
                           for f in sorted(d.glob("*.dialog"))}
    return out


#: the onnxruntime-web files web/wakeword.js loads (single-threaded wasm)
ORT_FILES = ["ort.wasm.bundle.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]


def add_wake_word(out: Path) -> list:
    """onnxruntime-web into ort/ and the wake word models into oww/
    (openWakeWord's; Precise's and precise-onnx-js in oww/precise/).

    Returns the wake words the site can hear (by OVOS name, e.g.
    "hey_mycroft"); empty, and no wake word on the page, without
    EMKAY_OWW.
    """
    src = os.environ.get("EMKAY_OWW")
    if not src:
        return []
    (out / "ort").mkdir()
    for name in ORT_FILES:
        shutil.copy(REPO / "node_modules/onnxruntime-web/dist" / name, out / "ort" / name)
    shutil.copytree(src, out / "oww")
    return sorted(f.name.rsplit("_v", 1)[0] for f in (out / "oww").glob("*_v*.onnx"))


#: piper-phonemize in WebAssembly (with espeak-ng's data), for web/piper.js
PIPER_FILES = ["piper_phonemize.js", "piper_phonemize.wasm", "piper_phonemize.data"]


def add_piper(out: Path):
    """piper-phonemize into piper/ (the voices come from Hugging Face when
    one is chosen; onnxruntime-web is the wake word's, in ort/)."""
    src = REPO / "node_modules/@diffusionstudio/piper-wasm/build"
    if not src.exists():
        print("no @diffusionstudio/piper-wasm (npm install): no Piper TTS", file=sys.stderr)
        return
    (out / "piper").mkdir()
    for name in PIPER_FILES:
        shutil.copy(src / name, out / "piper" / name)


def precise_models(out: Path) -> dict:
    """The Precise models the site ships (oww/precise/, from
    tools/fetch_wakeword_models.py): the model URL OVOS' config names ->
    the copy's path on the site."""
    f = out / "oww" / "precise" / "models.json"
    if not f.exists():
        return {}
    return {url: f"oww/precise/{local}" for url, local in json.loads(f.read_text()).items()}


def release_info() -> dict:
    """What this site is, to refer to: Emkay's version (the VERSION file),
    the CI build number and the commit it was built from ("local" and the
    working tree's commit when built by hand)."""
    import os
    import subprocess
    version = (REPO / "VERSION").read_text().strip()
    commit = os.environ.get("GITHUB_SHA", "")
    if not commit:
        try:
            commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"],
                                    capture_output=True, text=True).stdout.strip()
        except OSError:
            commit = ""
    return {"version": version, "build": os.environ.get("GITHUB_RUN_NUMBER", "local"),
            "commit": commit[:7]}


def main():
    wheelhouse, plan_path, *cache_dirs = sys.argv[1:]
    plan = json.load(open(plan_path))
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(REPO / "web", OUT)
    (OUT / "texts.json").write_text(json.dumps(locale_texts(), ensure_ascii=False))

    bundle = build_bundle(Path(wheelhouse), plan)
    bundle_name = f"bundle-{short_hash(bundle)}.zip"
    (OUT / bundle_name).write_bytes(bundle)

    intents = {}
    for lang, data in build_intents(cache_dirs).items():
        h = short_hash(data)
        name = f"intents-{lang}-{h}.zip"
        (OUT / name).write_bytes(data)
        intents[lang] = {"url": name, "hash": h, "bytes": len(data)}

    m2v = {}
    if os.environ.get("EMKAY_M2V"):
        for d in sorted(Path(os.environ["EMKAY_M2V"]).iterdir()):
            if (d / "model.safetensors").exists():
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
                    add_tree(zf, d, d.name)
                data = buf.getvalue()
                h = short_hash(data)
                name = f"m2v-{d.name}-{h}.zip"
                (OUT / name).write_bytes(data)
                m2v[d.name] = {"url": name, "hash": h, "bytes": len(data),
                               "source": (d / "SOURCE").read_text().strip()}

    wake_words = add_wake_word(OUT)
    add_piper(OUT)
    precise = precise_models(OUT)

    packages, pyodide_bytes = vendor_pyodide(plan["pyodide"] + ["micropip"])

    versions = sorted(n.split("-")[0] + "==" + n.split("-")[1] for n in plan["pure"])
    build = {
        **release_info(),
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pyodide_version": PYODIDE_VERSION,
        "pyodide_index": "pyodide/",
        "pyodide_packages": packages,
        "pyodide_bytes": pyodide_bytes,
        "bundle": bundle_name,
        "bundle_bytes": len(bundle),
        "intent_cache": intents,
        "m2v_models": m2v,
        "wake_words": wake_words,
        "precise_models": precise,
        "shimmed": plan["shimmed"],
        "dropped": plan["dropped"],
        "versions": versions,
    }
    (OUT / "build.json").write_text(json.dumps(build, indent=1))
    mb = lambda n: f"{n / 1e6:.1f} MB"
    print(f"site in {OUT}: pyodide {mb(pyodide_bytes)} + core, bundle {mb(len(bundle))}, "
          + ", ".join(f"intents {k} {mb(v['bytes'])}" for k, v in intents.items())
          + "".join(f", m2v {k} {mb(v['bytes'])}" for k, v in m2v.items()))


if __name__ == "__main__":
    main()
