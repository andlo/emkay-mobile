#!/usr/bin/env python3
"""Fetch the new visage (ovos-gui-visage's Flutter web build) into web/visage2/.

ovos-gui-visage (OscillateLabsLLC, Apache-2.0) publishes its web build only
as a Docker image: nginx serving the build, plus a sidecar config that
proxies the websockets and resource routes to OVOS. Emkay takes the build
out of a pinned image and serves it itself; web/visage2-shim.js stands in
for the sidecar (see that file).

Three changes to the build, nothing in the app itself:
  * <base href="/"> becomes "./", so it works below any path (GitHub Pages).
  * the shim is loaded before Flutter's bootstrap, so its WebSocket is the
    one the app gets.
  * Flutter's own (deprecated) service worker is not registered. It would
    take over visage2/ and so the res/ routes Emkay's sw.js answers.
Renderers the build never loads are left out (it is built for dart2js with
CanvasKit; Chromium gets canvaskit/chromium/).

Usage: python tools/fetch_visage2.py [dest]     (docker or podman needed)
"""
import pathlib
import re
import shutil
import subprocess
import sys

IMAGE = "ghcr.io/oscillatelabsllc/ovos-gui-visage:2.5.0"
#: the commit 2.5.0 was built from (image label org.opencontainers.image.revision)
REVISION = "a3d0253c2dc9bd3a62ed990739abab3ce78814fe"
ROOT_IN_IMAGE = "/usr/share/nginx/html"
REPO = pathlib.Path(__file__).resolve().parent.parent
#: what the build has but never loads
UNUSED = ["50x.html", "flutter_service_worker.js", "canvaskit/skwasm.js", "canvaskit/skwasm.wasm",
          "canvaskit/skwasm_heavy.js", "canvaskit/skwasm_heavy.wasm", "canvaskit/wimp.js",
          "canvaskit/wimp.wasm", "canvaskit/webparagraph"]


def engine() -> str:
    for name in ("docker", "podman"):
        if shutil.which(name):
            return name
    sys.exit("docker or podman is needed to fetch the visage web build")


def main():
    dest = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "web/visage2"
    run = engine()
    stamp = dest / ".image"
    if stamp.exists() and stamp.read_text().strip() == IMAGE:
        print(f"visage2: {IMAGE} already in {dest}")
        return
    shutil.rmtree(dest, ignore_errors=True)
    cid = subprocess.check_output([run, "create", IMAGE], text=True).strip().splitlines()[-1]
    try:
        subprocess.check_call([run, "cp", f"{cid}:{ROOT_IN_IMAGE}", str(dest)])
    finally:
        subprocess.call([run, "rm", cid], stdout=subprocess.DEVNULL)
    for name in UNUSED:
        p = dest / name
        shutil.rmtree(p) if p.is_dir() else p.unlink(missing_ok=True)
    for p in dest.rglob("*.symbols"):
        p.unlink()

    index = dest / "index.html"
    html = index.read_text()
    html = html.replace('<base href="/">', '<base href="./">')
    html = html.replace('<script src="flutter_bootstrap.js"',
                        '<script src="../visage2-shim.js"></script>\n  <script src="flutter_bootstrap.js"')
    index.write_text(html)
    boot = dest / "flutter_bootstrap.js"
    js = re.sub(r"_flutter\.loader\.load\(\{.*?\}\);", "_flutter.loader.load();",
                boot.read_text(), flags=re.S)
    boot.write_text(js)
    stamp.write_text(IMAGE + "\n")
    (dest / "SOURCE").write_text(
        f"ovos-gui-visage web build, from {IMAGE}\n"
        f"https://github.com/OscillateLabsLLC/ovos-gui-visage/tree/{REVISION}\n"
        "Apache-2.0. Changed by Emkay: base href, shim script, no Flutter service worker.\n")
    size = sum(p.stat().st_size for p in dest.rglob("*") if p.is_file())
    print(f"visage2: {IMAGE} -> {dest} ({size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
