"""Serve build/site on http://127.0.0.1:8080 for testing (no caching)."""
import functools
import http.server
from pathlib import Path

SITE = Path(__file__).resolve().parents[1] / "build/site"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".webmanifest": "application/manifest+json", ".mjs": "text/javascript",
                      ".js": "text/javascript", ".wasm": "application/wasm"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(
        ("127.0.0.1", 8080), functools.partial(Handler, directory=str(SITE))).serve_forever()
