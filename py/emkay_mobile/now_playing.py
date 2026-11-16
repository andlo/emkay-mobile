"""The "now playing" screen for OCP in legacy mode.

OCP (ovos-ocp-pipeline-plugin) with "legacy": true hands what it plays to
ovos-audio's AudioService, which plays it through a backend (here
ovos-audio-plugin-browser). Neither shows anything: on a device the
screen came from the classic OCP player (ovos-plugin-common-play, now
deprecated), whose GUI filled the `ovos.common_play` namespace, and
ovos-media no longer does. The GUI clients still have the pages for it:
ovos-gui-visage draws `ovos.common_play/OVOSSyncPlayer` (cover, title,
artist, a "live" badge, position, and buttons) from the same values the
classic OCP set.

This fills them, from what is already on the bus:

- ovos.common_play.search.populate: OCP's results, with title, artist and
  image, sent right after it starts the best one;
- mycroft.audio.playing_track / queue_end, mycroft.audio.service.pause /
  resume / stop: what AudioService does;
- ovos.common_play.playback_time: the backend's position and length.

The page's buttons come back as ovos.common_play.pause / resume / stop /
next / previous / seek (ovos-gui turns the GUI event into
"<namespace>.<event>"), which nothing answers in legacy mode; they become
the AudioService messages.

It belongs in OCP itself (its pipeline already is the `ovos.common_play`
application), and is proposed there; once an OCP with it is installed,
start() leaves the page to OCP.
"""
from ovos_bus_client.apis.gui import GUIInterface
from ovos_bus_client.message import Message

#: the GUI namespace and page the classic OCP used, and visage draws
NAMESPACE = "ovos.common_play"
PAGE = "OVOSSyncPlayer"

#: the page's buttons (GUI events) -> AudioService
_BUTTONS = {
    "pause": "mycroft.audio.service.pause",
    "resume": "mycroft.audio.service.resume",
    "stop": "mycroft.audio.service.stop",
    "next": "mycroft.audio.service.next",
    "previous": "mycroft.audio.service.prev",
}


def _image(entry: dict) -> str:
    """A picture the page can show: http(s) or data: (visage's rule)."""
    for key in ("image", "skill_icon", "bg_image"):
        value = str(entry.get(key) or "")
        if value.startswith(("http://", "https://", "data:")):
            return value
    return ""


class NowPlaying:
    def __init__(self, bus):
        self.bus = bus
        self.gui = GUIInterface(NAMESPACE, bus=bus)
        self.results = []      # OCP's last results (dicts), best first
        self.showing = False
        on = bus.on
        on("ovos.common_play.search.populate", self._on_results)
        on("mycroft.audio.playing_track", self._on_track)
        on("mycroft.audio.queue_end", self._on_end)
        on("mycroft.audio.service.stop", self._on_end)
        on("mycroft.audio.service.pause", lambda m: self._status("Paused"))
        on("mycroft.audio.service.resume", lambda m: self._status("Playing"))
        on("ovos.common_play.playback_time", self._on_time)
        for event, target in _BUTTONS.items():
            on(f"{NAMESPACE}.{event}", self._button(target))
        on(f"{NAMESPACE}.seek", self._on_seek)

    # ------------------------------------------------------------ OCP / audio
    def _on_results(self, message):
        playlist = (message.data or {}).get("playlist") or []
        if (message.data or {}).get("replace", True):
            self.results = list(playlist)
        else:
            self.results += list(playlist)
        if self.showing and self.results:
            self._fill(self._entry_for(self.gui.get("uri")))

    def _entry_for(self, uri) -> dict:
        """OCP's result for the URI AudioService plays; AudioService only
        has the address, OCP's results the rest. The first result is the
        one OCP started, for a stream whose address was resolved."""
        for entry in self.results:
            if uri and entry.get("uri") == uri:
                return entry
        return self.results[0] if self.results else {"uri": uri}

    def _on_track(self, message):
        uri = (message.data or {}).get("track") or ""
        self._fill(self._entry_for(uri), uri=uri)
        self.gui["status"] = "Playing"
        self.gui["position"] = 0
        self.gui.show_page(PAGE, override_idle=True)
        self.showing = True

    def _fill(self, entry: dict, uri: str = None):
        g = self.gui
        g["playerBackend"] = PAGE
        g["uri"] = uri or entry.get("uri") or g.get("uri") or ""
        g["title"] = entry.get("title") or entry.get("phrase") or ""
        g["artist"] = entry.get("artist") or entry.get("skill_name") or ""
        g["image"] = _image(entry)
        g["bg_image"] = g["image"]
        length = int(entry.get("length") or 0)      # ms; 0: live or unknown
        g["duration"] = length
        g["length"] = length
        g["canPrev"] = False
        g["canNext"] = False
        g["loopStatus"] = "None"
        g["shuffleStatus"] = False

    def _status(self, status):
        if self.showing:
            self.gui["status"] = status

    def _on_time(self, message):
        if not self.showing:
            return
        data = message.data or {}
        if data.get("length"):
            self.gui["duration"] = self.gui["length"] = int(data["length"])
        # only with a known length: a live stream's page counts the time
        # itself, and the visage reads a position as seconds when the
        # length is 0
        if self.gui.get("length"):
            self.gui["position"] = int(data.get("position") or 0)

    def _on_end(self, message=None):
        if not self.showing:
            return
        self.showing = False
        self.gui["status"] = "Stopped"
        self.gui.release()          # the screen goes back to the face

    # ------------------------------------------------------------ the buttons
    def _button(self, target):
        def press(message):
            self.bus.emit(message.forward(target))
        return press

    def _on_seek(self, message):
        ms = int((message.data or {}).get("seekValue") or 0)
        self.bus.emit(message.forward("mycroft.audio.service.set_track_position",
                                      {"position": ms}))


_now_playing = None


def start(bus):
    """Start it, unless OCP shows the page itself (ovos-ocp-pipeline-plugin
    with ocp_pipeline/legacy_gui.py, proposed upstream from this module)."""
    global _now_playing
    try:
        import ocp_pipeline.legacy_gui  # noqa: F401
        print("[emkay] OCP shows its own now playing page")
        return None
    except ImportError:
        pass
    _now_playing = NowPlaying(bus)
    return _now_playing
