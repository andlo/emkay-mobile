"""Profile the OVOS boot inside Pyodide: where do the minutes go?

Run with tools/node_run.mjs. EMKAY_MOUNT the intent cache and m2v models
where the worker would unpack them:

  EMKAY_MOUNT=build/intent_cache:/home/pyodide/.local/share/mycroft,build/m2v:/home/pyodide/.local/share/emkay-mobile/m2v \
    node tools/node_run.mjs wheelhouse plan.json tools/probes/profile_boot.py [boot|train|both]

Prints the 30 heaviest functions by own time and by cumulative time.
"""
import asyncio
import cProfile
import io
import pstats
import sys
import time

what = sys.argv[1] if len(sys.argv) > 1 else "boot"


def show(prof, title):
    """Print the heaviest functions of one profile."""
    for key in ("tottime", "cumulative"):
        s = io.StringIO()
        pstats.Stats(prof, stream=s).strip_dirs().sort_stats(key).print_stats(30)
        body = s.getvalue().split("ncalls", 1)[-1]
        print(f"\n===== {title}: top 30 by {key} =====\n   ncalls{body}")


from emkay_mobile import boot  # noqa: E402

prof = cProfile.Profile()
t = time.time()
prof.enable()
info = boot.start()
prof.disable()
print(f"boot {time.time() - t:.1f}s, {len(info['skills'])} skills")
if what in ("boot", "both"):
    show(prof, "boot")

if what in ("train", "both"):
    # the deferred thread bodies (padatious training) run once we yield
    prof2 = cProfile.Profile()
    t = time.time()
    prof2.enable()
    await asyncio.sleep(0.05)
    prof2.disable()
    print(f"\ntraining pass {time.time() - t:.1f}s")
    show(prof2, "training")
