"""Copy ovos-visage's browser files into this repo, pinned to one commit.

ovos-visage (Apache-2.0, Oscillate Labs) is served from the site root by its
own aiohttp server. Here it lives under web/visage/ on GitHub Pages, so the
root-absolute URLs it uses are rewritten:

  /static/...  ->  visage/...   (its own files)
  /res/...     ->  res/...      (the ovos-gui resource cache; served from the
                                 Python file system by the service worker)

Its server-side GUI state model (state.py) is copied too: it runs inside
Pyodide next to ovos-gui.

Usage: python3 tools/vendor_visage.py [COMMIT]
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
URL = "https://github.com/OscillateLabsLLC/ovos-visage"
COMMIT = sys.argv[1] if len(sys.argv) > 1 else (REPO / "VISAGE_COMMIT").read_text().strip()

REWRITES = [
    (re.compile(r'(["`])/static/'), r"\1visage/"),
    (re.compile(r'(["`(])/res/'), r"\1res/"),
    (re.compile(r'(["`])/res-abs/'), r"\1res-abs/"),
    (re.compile(r'(["`])/frameable/'), r"\1frameable/"),
]

with tempfile.TemporaryDirectory() as tmp:
    subprocess.run(["git", "clone", "-q", URL, tmp], check=True)
    subprocess.run(["git", "-C", tmp, "checkout", "-q", COMMIT], check=True)
    src = Path(tmp, "ovos_visage")

    web = REPO / "web/visage"
    shutil.rmtree(web, ignore_errors=True)
    shutil.copytree(src / "static", web)
    for f in web.rglob("*"):
        if f.suffix in (".js", ".css", ".html") and "vendor" not in f.parts:
            text = f.read_text()
            for pat, rep in REWRITES:
                text = pat.sub(rep, text)
            f.write_text(text)
    (web / "index.html").unlink()  # the page is web/index.html

    py = REPO / "py/ovos_visage"
    shutil.rmtree(py, ignore_errors=True)
    py.mkdir(parents=True)
    shutil.copy(src / "state.py", py / "state.py")
    (py / "__init__.py").write_text(
        f'"""ovos-visage {COMMIT[:12]}: only the GUI state model, vendored by tools/vendor_visage.py."""\n')
    shutil.copy(Path(tmp, "LICENSE"), REPO / "web/visage/LICENSE")
    (REPO / "VISAGE_COMMIT").write_text(COMMIT + "\n")
    print(f"vendored ovos-visage {COMMIT[:12]} into web/visage and py/ovos_visage")
