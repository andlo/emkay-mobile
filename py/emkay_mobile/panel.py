"""The stock ovos-control-panel, served from inside the worker.

On a device the panel (package ovos-control-panel, module ovos_webui) is a
FastAPI app run by uvicorn on a port, talking to the messagebus as a
client. A browser cannot listen on a port, so the same app is built the way
its own tests build it - `create_app(bus=..., connect_bus=False)`, with
OVOS' in-process bus - and called directly as an ASGI app:

    page/iframe --fetch--> sw.js (Service Worker) --BroadcastChannel-->
    app.js --postMessage--> worker.js --> request() below --> the panel

Nothing in the panel is changed. Its own security model applies as on a
device bound to loopback: the Host is 127.0.0.1, so pages are open and
anything privileged (installing, device controls) needs the access token
set on its Settings page; Origin/Sec-Fetch-Site are passed through as the
Service Worker saw them, so its cross-site check still refuses a request
another site sent.
"""
import json

#: The address the panel believes it is served on (loopback, as on a device
#: where only the device itself may use it without a token).
HOST = "127.0.0.1"

_app = None
_started = False


def _run_inline():
    """FastAPI runs plain `def` endpoints and file reads in a worker thread
    (anyio.to_thread.run_sync). There are no threads here, so they run in
    place, as anyio itself would with one thread: the event loop waits."""
    import anyio.to_thread

    async def run_sync(func, *args, abandon_on_cancel=False, cancellable=None,
                       limiter=None, **kwargs):
        return func(*args)

    anyio.to_thread.run_sync = run_sync


def app():
    """The panel's ASGI app, built once on OVOS' bus."""
    global _app
    if _app is None:
        _run_inline()
        from ovos_webui.service import create_app
        from . import boot
        _app = create_app(bus=boot.bus(), host=HOST, connect_bus=False)
    return _app


async def _lifespan():
    """Run the app's startup once (it attaches its log view to the bus)."""
    global _started
    if _started:
        return
    _started = True
    events = [{"type": "lifespan.startup"}]
    sent = []

    async def receive():
        return events.pop(0) if events else {"type": "lifespan.shutdown"}

    async def send(message):
        sent.append(message)

    import asyncio
    task = asyncio.ensure_future(app()({"type": "lifespan", "asgi": {"version": "3.0"},
                                         "state": {}}, receive, send))
    for _ in range(100):  # until startup is acknowledged
        if any(m["type"].startswith("lifespan.startup") for m in sent):
            break
        await asyncio.sleep(0)
    # the task stays parked on receive() for shutdown; that is what a server does
    _lifespan.task = task


async def request(method: str, path: str, query: str, headers_json: str, body):
    """Serve one HTTP request; returns (status, headers JSON, body bytes).

    Args:
        method: GET, POST, ...
        path: the panel's own path, e.g. "/api/status" (prefix removed)
        query: the query string without "?"
        headers_json: [[name, value], ...] as the Service Worker saw them
        body: request body (bytes, or a JS Uint8Array)
    """
    await _lifespan()
    if hasattr(body, "to_bytes"):
        body = body.to_bytes()
    body = bytes(body or b"")
    headers = [(k.lower().encode("latin-1"), v.encode("latin-1"))
               for k, v in json.loads(headers_json) if k.lower() != "host"]
    headers.append((b"host", HOST.encode()))
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": method.upper(), "scheme": "http",
        "path": path, "raw_path": path.encode(), "root_path": "",
        "query_string": (query or "").encode("latin-1"), "headers": headers,
        "client": (HOST, 50000), "server": (HOST, 80), "state": {},
    }
    chunks = [body]

    async def receive():
        if chunks:
            return {"type": "http.request", "body": chunks.pop(), "more_body": False}
        return {"type": "http.disconnect"}

    out = {"status": 500, "headers": [], "body": []}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
            out["headers"] = [(k.decode("latin-1"), v.decode("latin-1"))
                              for k, v in message.get("headers", [])]
        elif message["type"] == "http.response.body":
            out["body"].append(message.get("body", b""))

    await app()(scope, receive, send)
    return out["status"], json.dumps(out["headers"]), b"".join(out["body"])
