"""Where does an utterance get stuck in Pyodide?

In the page, a typed "what time is it" left the worker busy for minutes
with nothing logged. Pyodide has no signals, so a watchdog in
sys.setprofile prints the Python stack once the utterance has run for
WATCHDOG seconds, then every 30 s after that, and gives up after LIMIT.

  EMKAY_MOUNT=build/intent_cache:/home/pyodide/.local/share/mycroft,build/m2v:/home/pyodide/.local/share/emkay-mobile/m2v \
    node tools/node_run.mjs wheelhouse plan.json tools/probes/utter_hang.py ["utterance"]
"""
import asyncio
import sys
import time
import traceback

from emkay_mobile import boot

WATCHDOG, EVERY, LIMIT = 20.0, 30.0, 400.0
text = sys.argv[1] if len(sys.argv) > 1 else "what time is it"


class Stuck(Exception):
    """Raised by the watchdog to end a hung utterance."""


def watch(started):
    """A profile function that dumps the stack of whoever runs too long."""
    nxt = [started + WATCHDOG]

    def prof(frame, event, arg):
        now = time.time()
        if now >= nxt[0]:
            nxt[0] = now + EVERY
            print(f"\n=== still running after {now - started:.0f}s ===", flush=True)
            print("".join(traceback.format_stack(frame)[-25:]), flush=True)
            if now - started > LIMIT:
                sys.setprofile(None)
                raise Stuck()
    return prof


info = boot.start()
print(f"boot done: {info['seconds']}s", flush=True)
bus = boot.bus()
for t in ("speak", "intent_failure", "ovos.utterance.handled", "complete_intent_failure"):
    bus.on(t, lambda m, t=t: print(f"BUS {t}: {str(m.data)[:200]}", flush=True))
# let padatious' deferred pass finish first, as it would in the page
for _ in range(60):
    await asyncio.sleep(1)
print(f"utterance: {text!r}", flush=True)
t = time.time()
sys.setprofile(watch(t))
try:
    boot.utterance(text)
    for _ in range(30):
        await asyncio.sleep(1)
except Stuck:
    print("gave up", flush=True)
finally:
    sys.setprofile(None)
print(f"done after {time.time() - t:.1f}s", flush=True)
