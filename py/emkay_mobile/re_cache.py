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

A first start has no such file yet, and compiled all of them: 32 s before
the first answer. So the site ships them too. tools/build_intent_cache.py
trains padatious with the same padaos changes (padaos_speed.install) and
writes the patterns it compiled (PATTERNS_NAME); the opcodes themselves are
not the same on 64-bit CPython (MAXREPEAT is 2**32-1 there, 2**31-1 in
WebAssembly), so tools/re_seed.mjs compiles those patterns again in Pyodide
(write_seed) and puts the file into each language's intent cache (SEEDS),
which the worker unpacks before OVOS starts.
"""
import marshal
import os
import zlib
from array import array
import sys
import time

try:
    from ovos_utils.log import LOG
except ImportError:     # tools/re_seed.mjs: a bare Pyodide
    import logging
    LOG = logging.getLogger("re_cache")

#: where the cache lives (persistent: ~/.local is IndexedDB in the browser)
PATH = os.path.expanduser("~/.local/share/emkay-mobile/re-cache.marshal")
#: what the site ships with each language's intent cache (see above)
#: (~/.local/share/mycroft/intent_cache*/<lang>/re-cache.marshal)
SEEDS = os.path.expanduser("~/.local/share/mycroft")
#: their file name there
SEED_NAME = "re-cache.marshal"
#: what tools/build_intent_cache.py leaves for tools/re_seed.mjs: [[pattern, flags], ...]
PATTERNS_NAME = "re-patterns.json"

#: the opcodes are kept as bytes (array "I": _sre.CODESIZE is 4), and the
#: file is compressed: as lists of ints, Emkay's 16,000 regexes took 51 MB on
#: disk and far more in memory; like this 0.9 MB on disk, 42 MB in memory
_FORMAT = 2

_cache = None        # {(pattern, flags): (flags, code bytes, groups, groupindex, indexgroup)}
_used = set()        # the keys this process used or added: what is saved
_dirty = False
_original = None     # re._compiler.compile as Python has it
_hits = _new = 0
_loaded = frozenset()   # the keys the file had (for looking at what missed)
_misses = []            # a few patterns this process had to compile


def _stamp():
    import _sre
    return (_FORMAT, sys.version_info[:2], getattr(_sre, "MAGIC", None), _sre.CODESIZE, _sre.MAXREPEAT)


def _code(code):
    """Opcodes as stored: bytes of an array of C unsigned ints."""
    return array("I", code).tobytes()


def _sre_args(hit):
    """What _sre.compile takes after the pattern, from a stored entry."""
    flags, code, groups, groupindex, indexgroup = hit
    ops = array("I")
    ops.frombytes(code)
    return flags, ops.tolist(), groups, groupindex, indexgroup


def _read(path):
    """The regexes of one cache file, or {} if it is missing or not for this Python."""
    try:
        with open(path, "rb") as f:
            data = marshal.loads(zlib.decompress(f.read()))
        if data.get("stamp") == _stamp() and isinstance(data.get("regexes"), dict):
            return data["regexes"]
    except (OSError, EOFError, ValueError, TypeError, KeyError, AttributeError, zlib.error):
        pass
    return {}


def seeds(name=SEED_NAME):
    """The seed files called `name` the site shipped, one per language's
    intent cache. Without glob or fnmatch: they compile regexes, and this
    runs inside re's compile (_compile)."""
    found = []
    try:
        for cache in sorted(os.listdir(SEEDS)):
            if not cache.startswith("intent_cache"):
                continue
            for lang in sorted(os.listdir(os.path.join(SEEDS, cache))):
                path = os.path.join(SEEDS, cache, lang, name)
                if os.path.isfile(path):
                    found.append(path)
    except OSError:
        pass
    return found


def _load():
    global _cache, _loaded
    if _cache is None:
        _cache = {}
        for seed in seeds():
            _cache.update(_read(seed))
        _cache.update(_read(PATH))       # what this device compiled itself
        _loaded = frozenset(_cache)
    return _cache


def save():
    """Write what this process used, if it compiled anything new."""
    global _dirty
    if not _dirty or _cache is None:
        return
    tmp = f"{PATH}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(PATH), exist_ok=True)
        _write(tmp, {k: _cache[k] for k in _used if k in _cache})
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
        self.last = (int(flags), _code(code), int(groups),
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
            compiled = _sre.compile(p, *_sre_args(hit))
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


def fast(p, flags):
    """`p` compiled straight from the cache - none of re.compile's own
    Python around it - or None when the cache doesn't have it
    (padaos_lines.py)."""
    global _hits
    import _sre
    key = (p, int(flags))
    hit = _load().get(key)
    if hit is None:
        return None
    try:
        compiled = _sre.compile(p, *_sre_args(hit))
    except Exception:   # noqa: BLE001 - a bad entry: compiled again later
        _cache.pop(key, None)
        return None
    _used.add(key)
    _hits += 1
    return compiled


def used_patterns():
    """[[pattern, flags], ...]: what this process compiled or took from the cache."""
    return sorted([p, f] for p, f in _used)


def write_seed(patterns, path):
    """Compile `patterns` ([[pattern, flags], ...]) here and write their
    opcodes to `path` as a cache file (tools/re_seed.mjs). Returns how many."""
    import _sre
    import re._compiler as rc
    regexes = {}
    recorder = _Recorder(_sre)
    rc._sre = recorder
    try:
        for p, f in patterns:
            recorder.last = None
            try:
                rc.compile(p, f)
            except Exception:   # noqa: BLE001 - padaos skips such a line too
                continue
            if recorder.last is not None:
                regexes[(p, int(f))] = recorder.last
    finally:
        rc._sre = _sre
    _write(path, regexes)
    return len(regexes)


def _write(path, regexes):
    with open(path, "wb") as f:
        f.write(zlib.compress(marshal.dumps({"stamp": _stamp(), "regexes": regexes}), 6))


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
