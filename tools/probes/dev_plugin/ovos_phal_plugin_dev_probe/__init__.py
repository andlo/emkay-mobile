"""A PHAL plugin for tools/probes/template_browser.mjs: Emkay Dev runs it from files.

Each time OVOS speaks it says so on the bus (ovos.dev_probe.heard, with what
was said), and it answers ovos.dev_probe.ping with ovos.dev_probe.pong.
"""
from ovos_plugin_manager.templates.phal import PHALPlugin


class DevProbePlugin(PHALPlugin):

    def __init__(self, bus=None, name="ovos-phal-plugin-dev-probe", config=None):
        super().__init__(bus=bus, name=name, config=config)
        self._on("ovos.dev_probe.ping", self.on_ping)

    def on_speak(self, message):
        self.bus.emit(message.forward("ovos.dev_probe.heard",
                                      {"utterance": message.data.get("utterance", "")}))

    def on_ping(self, message):
        self.bus.emit(message.reply("ovos.dev_probe.pong", {"name": self.name}))
