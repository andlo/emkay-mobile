"""Serve build/site on http://127.0.0.1:8080 for testing (no caching).

    EMKAY_SITE=<dir>   serve another built site (default build/site)
    EMKAY_COEP=1       add the headers app.emkay.ai gets from Cloudflare
                       (COEP: credentialless, CORP: cross-origin), so Emkay
                       can be framed by a cross-origin isolated page such as
                       vscode.dev (Emkay Dev, #43)
"""
import functools
import http.server
import os
from pathlib import Path

SITE = Path(os.environ.get("EMKAY_SITE") or Path(__file__).resolve().parents[1] / "build/site")
COEP = bool(os.environ.get("EMKAY_COEP"))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".webmanifest": "application/manifest+json", ".mjs": "text/javascript",
                      ".js": "text/javascript", ".wasm": "application/wasm"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        if COEP:
            self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
            self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(
        ("127.0.0.1", 8080), functools.partial(Handler, directory=str(SITE))).serve_forever()
