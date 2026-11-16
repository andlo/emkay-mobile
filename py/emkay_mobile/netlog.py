"""Who is calling out: names the skill or plugin behind each request for the
network log (web/netlog.js).

The page's worker logs every request it makes. Python's go through
pyodide-http (requests and urllib, XMLHttpRequest) and Emkay's httpx
transport (fetch); right before each, this sets `emkayNetCaller` in the
worker to the package that made the call, found on the call stack: the first
frame that is not the HTTP machinery, the standard library or OVOS' shared
libraries, e.g. "ovos-skill-wikipedia" or "ovos-tts-plugin-server". Nothing
about the request itself is kept here.
"""
import re
import sys
from contextlib import contextmanager
from functools import lru_cache

#: packages on the way to the network that are not the one asking
_MACHINERY = {
    "requests", "urllib3", "httpx", "httpcore", "pyodide", "pyodide_http", "_pyodide",
    "emkay_mobile", "ovos_utils", "ovos_bus_client", "ovos_workshop", "ovos_plugin_manager",
    "ovos_config", "ovos_core", "concurrent", "certifi", "charset_normalizer", "idna",
    "anyio", "sniffio", "h11", "contextlib", "functools", "threading", "importlib",
}


@lru_cache(maxsize=None)
def _distribution(top: str) -> str:
    """The distribution a top-level package comes from, by its pip name in
    normal form (PEP 503: lower case, "-" between words)."""
    name = top
    try:
        from importlib.metadata import packages_distributions
        name = (packages_distributions().get(top) or [top])[0]
    except Exception:
        pass
    return re.sub(r"[-_.]+", "-", name).lower()


def caller() -> str:
    """The package making the current call, or "ovos" for OVOS itself."""
    stdlib = getattr(sys, "stdlib_module_names", ())
    frame = sys._getframe(1)
    while frame:
        top = (frame.f_globals.get("__name__") or "").split(".")[0]
        if top and top not in _MACHINERY and top not in stdlib and top != "__main__":
            return _distribution(top)
        frame = frame.f_back
    return "ovos"


@contextmanager
def calling(who: str = None):
    """Tell the worker who is calling for the requests made inside."""
    try:
        import js
    except ImportError:          # not in a browser (tests)
        yield
        return
    previous = getattr(js, "emkayNetCaller", None)
    js.emkayNetCaller = who or caller()
    try:
        yield
    finally:
        js.emkayNetCaller = previous


def install():
    """Name the caller of every request pyodide-http sends.

    pyodide-http's requests adapter and urllib handler import `send` from its
    _core by name, so the wrapper goes in all three places.
    """
    try:
        import pyodide_http._core as core
    except ImportError:
        return
    if getattr(core.send, "_emkay_netlog", False):
        return
    plain = core.send

    def send(request, *args, **kwargs):
        with calling(caller()):
            return plain(request, *args, **kwargs)

    send._emkay_netlog = True
    core.send = send
    for name in ("pyodide_http._requests", "pyodide_http._urllib"):
        module = sys.modules.get(name)
        if module is not None and getattr(module, "send", None) is plain:
            module.send = send
