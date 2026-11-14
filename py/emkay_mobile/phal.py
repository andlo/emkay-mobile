"""The phone's "hardware" for OVOS: a PHAL plugin whose device is the browser.

On a device, PHAL plugins answer OVOS' hardware messages: ovos-PHAL-plugin-
alsa turns `mycroft.volume.*` into mixer changes, ipgeo finds the location,
and so on. Here the hardware is the page, so this plugin answers the same
messages, with the same data, and hands the actual change to the page.

Volume follows ovos-PHAL-plugin-alsa exactly: `percent` is 0..1 on the bus,
`mycroft.volume.get` is answered with {"percent", "muted"}, every change is
reported the same way, and the level is kept in the plugin's own settings
file (~/.config/OpenVoiceOS/ovos-phal-plugin-browser.json, which lives in
IndexedDB like the rest of ~/.config). The page plays everything through
one gain node, which is this plugin's "mixer".
"""
import json

from ovos_bus_client.message import Message
from ovos_bus_client.session import SessionManager
from ovos_plugin_manager.phal import PHALPlugin
from ovos_utils.log import LOG

try:
    from json_database import JsonConfigXDG
except ImportError:  # pragma: no cover
    JsonConfigXDG = None


class BrowserPHAL(PHALPlugin):
    """PHAL for a browser tab: volume now; location, battery, network next."""

    def __init__(self, bus=None, config=None, post=None):
        """
        Args:
            bus: the OVOS bus
            config: the plugin's PHAL config section (default_volume)
            post: callable(dict) that hands a state change to the page
        """
        super().__init__(bus=bus, name="ovos-phal-plugin-browser", config=config or {})
        self._post = post or (lambda change: None)
        self.settings = (JsonConfigXDG(self.name, subfolder="OpenVoiceOS")
                         if JsonConfigXDG else {})
        if self.settings.get("first_boot", True):
            self.settings["volume"] = int(self.config.get("default_volume", 75))
            self.settings["muted"] = False
            self.settings["first_boot"] = False
            self._store()
        for topic, handler in self._handlers().items():
            self.bus.on(topic, handler)
        self._report()  # the page starts at the stored level

    def _handlers(self):
        return {
            "mycroft.volume.get": self.handle_volume_request,
            "mycroft.volume.set": self.handle_volume_change,
            "mycroft.volume.increase": self.handle_volume_increase,
            "mycroft.volume.decrease": self.handle_volume_decrease,
            "mycroft.volume.mute": self.handle_mute_request,
            "mycroft.volume.unmute": self.handle_unmute_request,
            "mycroft.volume.mute.toggle": self.handle_mute_toggle_request,
        }

    # --- the "mixer" ----------------------------------------------------
    @property
    def volume(self) -> int:
        """Current level, 0..100."""
        return int(self.settings.get("volume", 75))

    @property
    def muted(self) -> bool:
        return bool(self.settings.get("muted", False))

    def _store(self):
        if hasattr(self.settings, "store"):
            self.settings.store()

    def _report(self):
        """Tell the page the level to play at."""
        self._post({"volume": self.volume / 100, "muted": self.muted})

    def set_volume(self, percent, play_sound=True):
        """Set the level (0..100), clamped, as the alsa plugin does."""
        self.settings["volume"] = max(0, min(100, int(percent)))
        self._store()
        self._report()
        if play_sound:
            self.bus.emit(Message("mycroft.audio.play_sound",
                                  {"uri": "snd/blop-mark-diangelo.wav"}))
        self.handle_volume_request(Message("mycroft.volume.get"))

    def set_muted(self, muted: bool):
        self.settings["muted"] = bool(muted)
        self._store()
        self._report()
        self.handle_volume_request(Message("mycroft.volume.get"))

    # --- bus handlers (same contract as ovos-PHAL-plugin-alsa) -----------
    def validate_message_context(self, message) -> bool:
        """Only the device's own session controls its volume (as alsa)."""
        sid = SessionManager.get(message).session_id
        native = getattr(self.bus, "session_id", "default")
        return sid == native

    def handle_volume_request(self, message):
        if not self.validate_message_context(message):
            return
        self.bus.emit(message.response({"percent": self.volume / 100,
                                        "muted": self.muted}))

    def handle_volume_change(self, message):
        if not self.validate_message_context(message):
            return
        self.set_volume(message.data["percent"] * 100,
                        play_sound=message.data.get("play_sound", True))

    def handle_volume_increase(self, message):
        if not self.validate_message_context(message):
            return
        change = message.data.get("percent", .10) * 100 or 15
        self.set_volume(self.volume + abs(change),
                        play_sound=message.data.get("play_sound", True))

    def handle_volume_decrease(self, message):
        if not self.validate_message_context(message):
            return
        change = message.data.get("percent", -.10) * 100 or 15
        self.set_volume(self.volume - abs(change),
                        play_sound=message.data.get("play_sound", True))

    def handle_mute_request(self, message):
        if self.validate_message_context(message):
            LOG.info("User muted audio.")
            self.set_muted(True)

    def handle_unmute_request(self, message):
        if self.validate_message_context(message):
            LOG.info("User unmuted audio.")
            self.set_muted(False)

    def handle_mute_toggle_request(self, message):
        if self.validate_message_context(message):
            self.set_muted(not self.muted)

    def shutdown(self):
        for topic, handler in self._handlers().items():
            self.bus.remove(topic, handler)
        super().shutdown()


_plugin = None


def start(bus, post):
    """Load the plugin on the bus; `post(str)` sends JSON to the page."""
    global _plugin
    from ovos_config import Configuration
    conf = Configuration().get("PHAL", {}).get("ovos-phal-plugin-browser", {})
    _plugin = BrowserPHAL(bus=bus, config=conf, post=lambda change: post(json.dumps(change)))
    return _plugin
