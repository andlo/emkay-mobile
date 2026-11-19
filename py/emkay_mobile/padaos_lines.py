"""padaos' line regexes: each intent's sources kept between starts (issue #4).

With every regex's opcodes in re_cache.py, padaos' compile still took 2.5 s
after each start in WebAssembly: most of it building the pattern strings
(_create_intent_pattern: a few hundred thousand string operations for
Emkay's 22,000 template lines) and re.compile's own Python around each
cached regex. Neither depends on anything but an intent's lines and the
entities those lines use.

So the sources padaos made for an intent are kept, keyed by its name, its
lines, the entities it references (padaos' own _referenced_entities, as its
in-process cache keys them) and padaos' PATTERN_RULES_VERSION. The next
start takes them from here and gets each regex straight from re_cache
(re_cache.fast), without building or parsing anything. A missing or stale
entry, or a regex re_cache doesn't have, is built as before.

The sources are the same on every platform, so tools/build_intent_cache.py
ships them with each language's intent cache too (SEED_NAME), for a first
start. Kept as gzip'd JSON in ~/.local, which Emkay keeps in IndexedDB.
"""
import gzip
import hashlib
import json
import os
import re

from . import re_cache

#: what this device made (persistent: ~/.local is IndexedDB in the browser)
PATH = os.path.expanduser("~/.local/share/emkay-mobile/padaos-lines.json.gz")
#: the file name in each language's intent cache (re_cache.SEEDS)
SEED_NAME = "padaos-lines.json.gz"
#: bump when what is kept, or how padaos_speed builds it, changes
_FORMAT = 1
#: padaos compiles every line regex with this
_FLAGS = int(re.IGNORECASE)

_memo = None     # {key: [source, ...]}
_used = set()    # the keys this process used or added: what is saved
_dirty = False
hits = misses = 0


def _read(path):
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("format") == _FORMAT and isinstance(data.get("intents"), dict):
            return data["intents"]
    except (OSError, EOFError, ValueError, TypeError, AttributeError):
        pass
    return {}


def _load():
    global _memo
    if _memo is None:
        _memo = {}
        for seed in re_cache.seeds(SEED_NAME):
            _memo.update(_read(seed))
        _memo.update(_read(PATH))
    return _memo


def key(container, intent_name, lines, entities):
    """What an intent's regexes depend on, as a short string."""
    from ovos_padatious import padaos
    referenced = container._referenced_entities(intent_name, lines, entities)
    namespace = intent_name.split(':')[0] + ':'
    slots = [name[len(namespace):] if name.startswith(namespace) else name
             for name, _ in referenced]
    if len(set(slots)) == len(slots):
        # each slot filled by one entity: their order changes nothing (and
        # differs from one start to the next)
        referenced = tuple(sorted(referenced))
    text = repr((_FORMAT, padaos.PATTERN_RULES_VERSION, intent_name,
                 tuple(sorted(lines)), referenced))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def get(k):
    """The intent's compiled regexes from what was kept, or None."""
    global hits
    sources = _load().get(k)
    if sources is None:
        return None
    regexes = []
    for source in sources:
        compiled = re_cache.fast(source, _FLAGS)
        if compiled is None:
            return None          # build them all again (and keep them)
        regexes.append(compiled)
    _used.add(k)
    hits += 1
    return regexes


def put(k, regexes):
    global _dirty, misses
    _load()[k] = [r.pattern for r in regexes]
    _used.add(k)
    _dirty = True
    misses += 1


def save():
    """Write what this process used, if it made anything new."""
    global _dirty
    if not _dirty or _memo is None:
        return
    tmp = f"{PATH}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(PATH), exist_ok=True)
        write({k: _memo[k] for k in _used if k in _memo}, tmp)
        os.replace(tmp, PATH)
        _dirty = False
    except (OSError, ValueError):
        pass


def write(intents, path):
    """A file of `intents` ({key: [source, ...]}) at `path`."""
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=6) as f:
        json.dump({"format": _FORMAT, "intents": intents}, f)


def used():
    """{key: [source, ...]}: what this process used or made (the build's seed)."""
    memo = _load()
    return {k: memo[k] for k in sorted(_used) if k in memo}
