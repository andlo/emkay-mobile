"""httpx through the browser, as pyodide-http does for requests and urllib.

httpx (encode/httpx) sends through httpcore, which opens sockets; a
browser has none, so every httpx request fails in Pyodide. Skills use it
directly or through libraries (pyradios, behind ovos-skill-pyradios, for
one). pyodide-http patches requests and urllib, not httpx.

This gives httpx's own transports a browser body, keeping everything else
of httpx (clients, redirects, auth, cookies, timeouts):

- HTTPTransport.handle_request: a synchronous XMLHttpRequest, pyodide-http's
  own `send` (allowed in a Web Worker, where OVOS runs);
- AsyncHTTPTransport.handle_async_request: the browser's fetch (pyfetch).

The browser decompresses bodies itself, so Content-Encoding is dropped from
the answer (httpx would try again), and headers a page may not set
(User-Agent, Host, ...) are left to the browser. The usual rule of the web
applies: the site must allow the request (CORS).

httpx is usually installed after the site has started (with a skill), so
the patch is applied when httpx is first imported (install()).
"""
import importlib.abc
import sys

#: headers the browser sets itself and refuses from a page
_FORBIDDEN = {"accept-charset", "accept-encoding", "connection", "content-length",
              "cookie", "date", "host", "keep-alive", "origin", "referer", "te",
              "trailer", "transfer-encoding", "upgrade", "user-agent", "via"}
#: answer headers that describe the wire format, not the body we hand on
_WIRE = {"content-encoding", "content-length", "transfer-encoding"}


def _timeout(request) -> float:
    t = request.extensions.get("timeout") or {}
    return float(t.get("read") or t.get("connect") or 0)


def _headers_out(request):
    return {k: v for k, v in request.headers.items() if k.lower() not in _FORBIDDEN}


def patch(httpx):
    """Give httpx's transports the browser's fetch. Safe to call twice."""
    if getattr(httpx, "_emkay_fetch", False):
        return
    if not hasattr(httpx, "HTTPTransport"):   # httpx 1.0 is a rewrite without it
        print(f"[emkay] httpx {getattr(httpx, '__version__', '?')}: no HTTPTransport, "
              "left as it is (no browser transport)")
        httpx._emkay_fetch = True
        return

    def handle_request(self, request):
        from pyodide_http._core import Request, send
        req = Request(request.method, str(request.url))
        req.timeout = _timeout(request)
        for k, v in _headers_out(request).items():
            req.set_header(k, v)
        body = request.read()
        if body:
            req.set_body(body)
        try:
            r = send(req)
        except Exception as e:   # pyodide-http's errors -> httpx's, for callers' except clauses
            raise httpx.ConnectError(str(e), request=request) from e
        return httpx.Response(
            r.status_code, request=request, content=r.body,
            headers=[(k, v) for k, v in r.headers.items() if k.lower() not in _WIRE])

    async def handle_async_request(self, request):
        from pyodide.http import pyfetch
        kwargs = {"method": request.method, "headers": _headers_out(request)}
        body = await request.aread()
        if body:
            kwargs["body"] = body
        from . import netlog
        try:
            with netlog.calling():   # the network log names the caller
                fetching = pyfetch(str(request.url), **kwargs)
            r = await fetching
            content = await r.bytes()
        except Exception as e:
            raise httpx.ConnectError(str(e), request=request) from e
        return httpx.Response(
            r.status, request=request, content=content,
            headers=[(k, v) for k, v in r.headers.items() if k.lower() not in _WIRE])

    httpx.HTTPTransport.handle_request = handle_request
    httpx.AsyncHTTPTransport.handle_async_request = handle_async_request
    httpx._emkay_fetch = True


class _PatchWhenImported(importlib.abc.MetaPathFinder):
    """Runs patch() right after `import httpx` has executed httpx."""

    def find_spec(self, name, path=None, target=None):
        if name != "httpx":
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None and spec.loader is not None:
                exec_module = spec.loader.exec_module

                def exec_and_patch(module, _exec=exec_module):
                    _exec(module)
                    patch(module)
                spec.loader.exec_module = exec_and_patch
                return spec
        return None


def install():
    """Patch httpx now if it is loaded, else as soon as it is imported."""
    if "httpx" in sys.modules:
        patch(sys.modules["httpx"])
    elif not any(isinstance(f, _PatchWhenImported) for f in sys.meta_path):
        sys.meta_path.insert(0, _PatchWhenImported())
