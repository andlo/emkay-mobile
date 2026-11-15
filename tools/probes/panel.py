"""The stock ovos-control-panel answering requests inside Pyodide.

Boots OVOS, then sends the panel a few requests through emkay_mobile.panel
the way the Service Worker will, and prints status, type and size.

  EMKAY_MOUNT=build/intent_cache:/home/pyodide/.local/share/mycroft,build/m2v:/home/pyodide/.local/share/emkay-mobile/m2v \
    node tools/node_run.mjs wheelhouse plan.json tools/probes/panel.py
"""
import json
import time

from emkay_mobile import boot, panel

T0 = time.time()
info = boot.start()
print(f"boot done: {info['seconds']}s", flush=True)

SAME_SITE = [["sec-fetch-site", "same-origin"], ["origin", "http://127.0.0.1"]]
for method, path, query, headers, body in [
    ("GET", "/", "", [], b""),
    ("GET", "/api/status", "", [], b""),
    ("GET", "/static/app.js", "", [], b""),
    ("GET", "/controls", "", [], b""),
    ("GET", "/api/config/user", "", [], b""),
    ("POST", "/api/logout", "", [], b""),            # no origin headers: refused
    ("POST", "/api/logout", "", SAME_SITE, b""),     # same site: allowed
]:
    t = time.time()
    try:
        status, hdrs, data = await panel.request(method, path, query, json.dumps(headers), body)
        ctype = dict(json.loads(hdrs)).get("content-type", "?")
        print(f"{method} {path}: {status} {ctype} {len(data)} B in {time.time() - t:.2f}s "
              f"{data[:120]!r}", flush=True)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"{method} {path}: FAILED {e!r}", flush=True)
