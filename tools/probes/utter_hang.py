"""Where does the Pyodide event loop get stuck?

In the page the worker stopped answering after padatious' deferred padaos
compile, with nothing logged. Pyodide has no signals, so this uses a
heartbeat: an asyncio task stamps the time every second, and a
sys.setprofile hook prints the Python stack whenever the stamp is older
than STALE seconds (the loop is then stuck in some callback), at most
every EVERY seconds. After the loop has settled, it sends an utterance.

  EMKAY_MOUNT=build/intent_cache:/home/pyodide/.local/share/mycroft,build/m2v:/home/pyodide/.local/share/emkay-mobile/m2v \
    node tools/node_run.mjs wheelhouse plan.json tools/probes/utter_hang.py ["utterance"]
"""
import asyncio
import sys
import time
import traceback

from emkay_mobile import boot

STALE, EVERY = 20.0, 30.0
text = sys.argv[1] if len(sys.argv) > 1 else "what time is it"
beat = [time.time()]
next_dump = [0.0]


async def heartbeat():
    """Stamp the time while the event loop gets to run."""
    while True:
        beat[0] = time.time()
        await asyncio.sleep(1)


def prof(frame, event, arg):
    """Dump the stack of whatever keeps the loop from running."""
    now = time.time()
    if now - beat[0] > STALE and now >= next_dump[0]:
        next_dump[0] = now + EVERY
        print(f"\n=== loop stuck for {now - beat[0]:.0f}s ===", flush=True)
        print("".join(traceback.format_stack(frame)[-30:]), flush=True)


info = boot.start()
print(f"boot done: {info['seconds']}s", flush=True)
bus = boot.bus()
for t in ("speak", "intent_failure", "ovos.utterance.handled", "complete_intent_failure"):
    bus.on(t, lambda m, t=t: print(f"BUS {t}: {str(m.data)[:200]}", flush=True))
asyncio.ensure_future(heartbeat())

# The profile hook makes padaos' compile many times slower, so it goes in
# only once the deferred compile is over (the hang came after it).
from ovos_padatious import padaos  # noqa: E402
_compile = padaos.IntentContainer._compile


def compiled_then_watch(self, *a, **k):
    """Run padaos' compile, then start watching the loop."""
    try:
        return _compile(self, *a, **k)
    finally:
        print(f"padaos compiled; watching the loop", flush=True)
        beat[0] = time.time()
        sys.setprofile(prof)


padaos.IntentContainer._compile = compiled_then_watch
await asyncio.sleep(90)
print(f"utterance: {text!r}", flush=True)
t = time.time()
boot.utterance(text)
await asyncio.sleep(60)
sys.setprofile(None)
print(f"done after {time.time() - t:.1f}s", flush=True)
