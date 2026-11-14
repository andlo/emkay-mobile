"""The browser PHAL plugin against the stock volume skill, in Pyodide.

Boots OVOS, loads emkay_mobile.phal with a page stand-in that prints what
the page would be told, and asks the volume skill a few things.

  EMKAY_MOUNT=build/intent_cache:/home/pyodide/.local/share/mycroft,build/m2v:/home/pyodide/.local/share/emkay-mobile/m2v \
    node tools/node_run.mjs wheelhouse plan.json tools/probes/volume.py
"""
import asyncio
import time

from emkay_mobile import boot, phal

T0 = time.time()


def log(msg):
    print(f"[{time.time() - T0:6.1f}s] {msg}", flush=True)


info = boot.start()
log(f"boot done: {info['seconds']}s")
bus = boot.bus()
phal.start(bus, lambda raw: log(f"PAGE gets {raw}"))
for topic in ("speak", "mycroft.skill.handler.start"):
    bus.on(topic, lambda m, t=topic: log(f"BUS {t}: {str(m.data)[:140]}"))
await asyncio.sleep(60)
for text in ("set the volume to 40 percent", "what is the volume",
             "turn the volume up", "mute", "unmute"):
    log(f"utterance: {text!r}")
    boot.utterance(text)
    await asyncio.sleep(8)
