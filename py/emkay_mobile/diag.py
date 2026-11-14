"""Opt-in timing probes for slow spots (EMKAY_DIAG=1). Not used in normal runs.

Counts how often padatious trains a network versus loads one from the
intent cache, and how long each takes, so a cold boot can be explained.
"""
import sys
import time
from collections import defaultdict

STATS = defaultdict(lambda: [0, 0.0])   # what -> [count, seconds]


def _probe(owner, attr, what):
    fn = getattr(owner, attr)

    def wrapper(*a, **k):
        t = time.time()
        try:
            return fn(*a, **k)
        finally:
            s = STATS[what]
            s[0] += 1
            s[1] += time.time() - t
    setattr(owner, attr, wrapper if not isinstance(fn, classmethod) else classmethod(wrapper))


MISSES = []   # (name, cache folder, first lines) for registrations whose hash missed


def _watch_cache_hits():
    """Log registrations padatious will retrain because the cache hash differs."""
    import ovos_padatious
    from os.path import isfile, join, splitext
    from ovos_padatious import training_manager as tm
    orig = tm.TrainingManager.add

    def add(self, name, lines, reload_cache=False, must_train=True):
        if must_train:
            try:
                min_ver = splitext(ovos_padatious.__version__)[0]
                salt = [min_ver, "format2"]
                if tm.has_combining_marks(lines):
                    salt.append("marks")
                new = tm.lines_hash(salt + lines)
                fn = join(self.cache, name + ".hash")
                old = open(fn, "rb").read() if isfile(fn) else None
                if old != new:
                    MISSES.append((name, self.cache, "missing" if old is None else "changed", list(lines)[:4]))
            except Exception as e:
                MISSES.append((name, self.cache, f"probe error {e!r}", []))
        return orig(self, name, lines, reload_cache=reload_cache, must_train=must_train)
    tm.TrainingManager.add = add


def install():
    _watch_cache_hits()
    from ovos_padatious import training_manager, intent, entity, intent_container
    _probe(training_manager, "_train_and_save", "padatious: train a network")
    _probe(intent.Intent, "from_file", "padatious: load an intent from cache")
    _probe(entity.Entity, "from_file", "padatious: load an entity from cache")
    _probe(intent_container.IntentContainer, "train", "padatious: IntentContainer.train")


def report():
    print(f"[emkay] diag: {len(MISSES)} padatious cache misses", file=sys.stderr)
    for m in MISSES[:15]:
        print(f"   {m}", file=sys.stderr)
    lines = [f"{v[0]:5d} x {v[1]:7.1f}s  {k}" for k, v in sorted(STATS.items())]
    print("[emkay] diag:\n  " + "\n  ".join(lines), file=sys.stderr)
    return lines
