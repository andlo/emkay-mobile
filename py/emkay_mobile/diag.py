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


def install():
    from ovos_padatious import training_manager, intent, entity, intent_container
    _probe(training_manager, "_train_and_save", "padatious: train a network")
    _probe(intent.Intent, "from_file", "padatious: load an intent from cache")
    _probe(entity.Entity, "from_file", "padatious: load an entity from cache")
    _probe(intent_container.IntentContainer, "train", "padatious: IntentContainer.train")


def report():
    lines = [f"{v[0]:5d} x {v[1]:7.1f}s  {k}" for k, v in sorted(STATS.items())]
    print("[emkay] diag:\n  " + "\n  ".join(lines), file=sys.stderr)
    return lines
