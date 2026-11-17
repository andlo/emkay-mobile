"""A stand-in skill for tools/probes/hivemind_node.mjs: on the OVOS bus,
answer every utterance with `speak` "You said …", routed back to whoever
asked (message.reply), so a HiveMind satellite gets it.

  python3 tools/probes/hivemind_responder.py   (next to ovos-messagebus)
"""
import time

from ovos_bus_client import MessageBusClient

bus = MessageBusClient()
bus.run_in_thread()
bus.connected_event.wait()


def on_utterance(message):
    utterance = (message.data.get("utterances") or [""])[0]
    print("heard:", utterance, flush=True)
    bus.emit(message.reply("speak", {"utterance": f"You said {utterance}",
                                     "lang": message.data.get("lang")}))


bus.on("recognizer_loop:utterance", on_utterance)
while True:
    time.sleep(1)
