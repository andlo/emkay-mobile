"""padaos' regexes from a cache, not compiled again at every start (issue #4).

After every start padatious' padaos compiles a regex for each template line
of every intent: about 2500 for Emkay's skills. Python's `re.compile` is
mostly Python - re._parser and re._compiler turn the pattern into a list of
opcodes, and only the last step, `_sre.compile`, is C. In WebAssembly that
Python part took 28 s, and Emkay has one thread: the first question after
"ready" waited for it (37 s for "what time is it", 0.6 s the next time).

The opcodes depend on the pattern, the flags and the Python version only.
So while padaos compiles, `re._compiler.compile` looks them up here and
hands them straight to `_sre.compile`; what it had to compile is noted and
saved (marshal, in ~/.local, which Emkay keeps in IndexedDB) for the next
start. On a normal CPU: 1.27 s for 3000 patterns compiled, 0.02 s from the
cache. The file is tied to the Python version and `_sre.MAGIC`; anything
unexpected falls back to the ordinary compile.
"""
import marshal
import os
import sys
import time

from ovos_utils.log import LOG

#: where the cache lives (persistent: ~/.local is IndexedDB in the browser)
PATH = os.path.expanduser("~/.local/share/emkay-mobile/re-cache.marshal")

_cache = None        # {(pattern, flags): (flags, code, groups, groupindex, indexgroup)}
_used = set()        # the keys this process used or added: what is saved
_dirty = False
_original = None     # re._compiler.compile as Python has it
_hits = _new = 0
_loaded = frozenset()   # the keys the file had (for looking at what missed)
_misses = []            # a few patterns this process had to compile


def _stamp():
    import _sre
    return (sys.version_info[:2], getattr(_sre, "MAGIC", None), _sre.CODESIZE)


def _load():
    global _cache
    if _cache is None:
        _cache = {}
        try:
            with open(PATH, "rb") as f:
                data = marshal.load(f)
            if data.get("stamp") == _stamp():
                _cache = data["regexes"]
                global _loaded
                _loaded = frozenset(_cache)
        except (OSError, EOFError, ValueError, TypeError, KeyError, AttributeError):
            _cache = {}
    return _cache


def save():
    """Write what this process used, if it compiled anything new."""
    global _dirty
    if not _dirty or _cache is None:
        return
    tmp = f"{PATH}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(PATH), exist_ok=True)
        with open(tmp, "wb") as f:
            marshal.dump({"stamp": _stamp(),
                          "regexes": {k: _cache[k] for k in _used if k in _cache}}, f)
        os.replace(tmp, PATH)
        _dirty = False
    except (OSError, ValueError) as e:
        LOG.debug("regex cache not written: %s", e)


class _Recorder:
    """Stands in for _sre while one pattern compiles, to note what it was given."""

    def __init__(self, sre):
        self._sre = sre
        self.last = None

    def __getattr__(self, name):
        return getattr(self._sre, name)

    def compile(self, pattern, flags, code, groups, groupindex, indexgroup):
        self.last = (int(flags), [int(c) for c in code], int(groups),
                     dict(groupindex), tuple(indexgroup))
        return self._sre.compile(pattern, flags, code, groups, groupindex, indexgroup)


def _compile(p, flags=0):
    """re._compiler.compile, from the cache when it can."""
    global _dirty, _hits, _new
    import _sre
    import re._compiler as rc
    if not isinstance(p, str):
        return _original(p, flags)
    key = (p, int(flags))
    hit = _load().get(key)
    if hit is not None:
        try:
            compiled = _sre.compile(p, *hit)
            _used.add(key)
            _hits += 1
            return compiled
        except Exception:   # noqa: BLE001 - a bad entry: compile it again
            _cache.pop(key, None)
    recorder = _Recorder(_sre)
    rc._sre = recorder
    try:
        compiled = _original(p, flags)
    finally:
        rc._sre = _sre
    if recorder.last is not None:
        _cache[key] = recorder.last
        _used.add(key)
        _new += 1
        if len(_misses) < 5:
            _misses.append(p)
        _dirty = True
    return compiled


def around(compile_fn):
    """Wrap a compile (padaos.IntentContainer._compile) so its regexes come
    from the cache while it runs, and what it added is saved after."""
    def wrapped(*args, **kwargs):
        global _original
        import re._compiler as rc
        if _original is not None:   # already inside one
            return compile_fn(*args, **kwargs)
        _original = rc.compile
        rc.compile = _compile
        hits, new, t0 = _hits, _new, time.time()
        try:
            return compile_fn(*args, **kwargs)
        finally:
            rc.compile = _original
            _original = None
            LOG.info(f"padaos regexes: {_hits - hits} from the cache, {_new - new} compiled, "
                     f"in {time.time() - t0:.1f} s")
            save()
    wrapped.__wrapped__ = compile_fn
    return wrapped
