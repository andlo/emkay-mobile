"""End to end in Pyodide: boot, let padatious settle, ask, and see the answer.

Prints the bus messages that show how an utterance was handled, a
heartbeat that proves the event loop is still running, and any endless
waits browser.py refused (SKIPPED_WAITS entries with no timeout).

  EMKAY_MOUNT=build/intent_cache:/home/pyodide/.local/share/mycroft,build/m2v:/home/pyodide/.local/share/emkay-mobile/m2v \
    node tools/node_run.mjs wheelhouse plan.json tools/probes/e2e.py ["utterance" ...]
"""
import asyncio
import sys
import time

from emkay_mobile import boot, browser

texts = sys.argv[1:] or ["what time is it", "tell me a joke"]
T0 = time.time()


def log(msg):
    """Print with seconds since start."""
    print(f"[{time.time() - T0:6.1f}s] {msg}", flush=True)


info = boot.start()
log(f"boot done: {info['seconds']}s, {len(info['skills'])} skills")
bus = boot.bus()
for topic in ("speak", "complete_intent_failure", "ovos.utterance.handled",
              "mycroft.skill.handler.start", "mycroft.skills.trained"):
    bus.on(topic, lambda m, t=topic: log(f"BUS {t}: {str(m.data)[:160]}"))


async def heartbeat():
    """Log every 15 s while the event loop runs."""
    while True:
        await asyncio.sleep(15)
        log("loop alive")

asyncio.ensure_future(heartbeat())
await asyncio.sleep(90)  # padatious' deferred compile runs in here
for text in texts:
    log(f"utterance: {text!r}")
    boot.utterance(text)
    await asyncio.sleep(30)
forever = [w for w in browser.SKIPPED_WAITS if w[0] is None]
log(f"endless waits refused: {len(forever)}")
for w in forever[:10]:
    log(f"  {w[1]} at {w[2]}")
