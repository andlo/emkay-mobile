"""Does padatious' deferred training pass end in the browser?

After boot the page's worker stayed busy for minutes after the first padaos
compile. This logs every training-related call with a timestamp for a few
minutes so a loop that never settles shows up as repeating lines.

  EMKAY_MOUNT=build/intent_cache:/home/pyodide/.local/share/mycroft,build/m2v:/home/pyodide/.local/share/emkay-mobile/m2v \
    node tools/node_run.mjs wheelhouse plan.json tools/probes/train_loop.py [seconds]
"""
import asyncio
import functools
import sys
import time

from emkay_mobile import boot

T0 = time.time()


def log(msg):
    """Print with seconds since probe start."""
    print(f"[{time.time() - T0:7.1f}s] {msg}", flush=True)


def trace(cls, name, describe=lambda self, *a, **k: ""):
    """Wrap cls.name so each call logs its start, end and duration."""
    orig = getattr(cls, name)

    @functools.wraps(orig)
    def wrapper(self, *a, **k):
        t = time.time()
        log(f"> {cls.__name__}.{name} {describe(self, *a, **k)}")
        try:
            return orig(self, *a, **k)
        finally:
            log(f"< {cls.__name__}.{name} {time.time() - t:.1f}s {describe(self, *a, **k)}")
    setattr(cls, name, wrapper)


from ovos_padatious.opm import PadatiousPipeline  # noqa: E402
from ovos_padatious.intent_container import IntentContainer  # noqa: E402
from ovos_padatious import padaos  # noqa: E402

state = lambda self, *a, **k: (f"must_train={getattr(self, 'must_train', '?')} "
                               f"padaos_dirty={getattr(getattr(self, 'padaos', None), 'must_compile', '?')}")
trace(PadatiousPipeline, "_train_sync", lambda self, *a, **k: str(k or a))
trace(PadatiousPipeline, "_train_worker")
trace(IntentContainer, "train", state)
trace(IntentContainer, "_background_train_loop", state)
trace(IntentContainer, "_wait_for_quiet")
for cname in dir(padaos):
    c = getattr(padaos, cname)
    if isinstance(c, type) and hasattr(c, "_compile"):
        trace(c, "_compile")

info = boot.start()
log(f"boot done: {info['seconds']}s, {len(info['skills'])} skills")
total = float(sys.argv[1]) if len(sys.argv) > 1 else 300
while time.time() - T0 < total:
    await asyncio.sleep(1)
from ovos_padatious.opm import PadatiousPipeline as P  # noqa: E402
log("end; containers: " + ", ".join(
    f"{lang}: needs_compile={c.needs_compile}" for lang, c in
    next(o for o in __import__("gc").get_objects() if isinstance(o, P)).containers.items()))
