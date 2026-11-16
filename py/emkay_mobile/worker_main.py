"""The Python end of the page's Web Worker.

The worker owns everything OVOS: the bus, ovos-core and its skills, ovos-gui,
the small listener/audio halves (speech.py) and the PHAL plugin for the
phone's "hardware" (ovos-phal-plugin-browser). The page owns what only a browser tab can
reach: the screen, the microphone and the speaker.

They talk through postMessage. worker.js calls the functions below; Python
answers through the `js_post(kind, payload, data=None)` callable given to
`start()`. The kinds are:

  "gui"    one GUI-protocol message (JSON) for the visage
  "audio"  speech to play: payload is JSON metadata, data the WAV bytes
  "bus"    one of the few bus events the page reacts to itself
  "phal"   from the browser PHAL plugin: a volume level, or a request
           such as {"request": "location"}
"""
import json
import time

# Emkay's own modules first: importing boot runs browser.install(), which
# puts the stand-ins for native packages (shims/: pexpect, psutil, ...) on
# the path; ovos-utils' security module imports pexpect
from . import boot, browser, gui, panel, speech

import ovos_phal_plugin_browser as phal   # the browser tab as the device

_js_post = None   # set by start(): post(kind, payload[, data])


def _post(kind: str, payload: str, data: bytes = None):
    """Hand something to the page. `data`, if given, arrives as a Uint8Array."""
    if _js_post is None:
        return
    if data is not None:
        from pyodide.ffi import to_js
        _js_post(kind, payload, to_js(data))   # copied into a Uint8Array
    else:
        _js_post(kind, payload)


def start(js_post, user_config=None) -> str:
    """Boot OVOS and wire it to the page; return a JSON summary of the boot."""
    global _js_post
    _js_post = js_post
    try:
        import pyodide_http
        pyodide_http.patch_all()   # requests/urllib through the browser's fetch
    except ImportError:
        pass
    t = time.time()
    info = boot.start(user_config=user_config)
    print(f"[emkay] core up in {time.time() - t:.1f}s")
    bus = boot.bus()
    t = time.time()
    gui.start(bus, lambda raw: _post("gui", raw))
    print(f"[emkay] gui up in {time.time() - t:.1f}s")
    speech.start(bus, lambda wav, meta: _post("audio", json.dumps(meta), wav))
    _start_audio_service(bus)
    from . import panel
    panel.follow_sensors(bus)                          # before the first reading
    phal.start(bus, lambda raw: _post("phal", raw))   # the phone's "hardware"
    _report_status(bus)
    bus.on("message", _watch)
    # a pipeline plugin installed in the panel is placed in the pipeline
    # and loaded at once (pipeline_place.py)
    from . import pipeline_place
    bus.on("ovos.pip.install.complete", pipeline_place.on_installed)
    pipeline_place.reload_media_providers()   # notes the providers OCP loaded at boot
    info["skipped_waits"] = browser.SKIPPED_WAITS[:]
    return json.dumps(info)


_audio_service = None


def _start_audio_service(bus):
    """ovos-audio's classic AudioService, unchanged: music, radio, podcasts.

    On a device ovos-audio runs it next to speech; here speech is speech.py,
    so only the AudioService is started. Its player is
    ovos-audio-plugin-browser, which plays in the page's <audio> element
    (web/media.js). OCP plays through it (ovos-ocp-pipeline-plugin with
    "legacy": true, boot.py), as do skills that use AudioServiceInterface;
    it ducks the music while OVOS speaks or listens. The classic OCP
    backend (ovos-plugin-common-play) is not installed, so it is off.
    """
    global _audio_service
    t = time.time()
    try:
        from ovos_audio.audio import AudioService
        _audio_service = AudioService(bus, disable_ocp=True)
        names = [s.name for s in _audio_service.service]
        print(f"[emkay] audio service up in {time.time() - t:.1f}s: {names}")
    except Exception as e:   # music is a feature; speech must not depend on it
        print(f"[emkay] audio service not started: {e!r}")


#: The device services whose job a part of Emkay does, so they answer the
#: same status questions (ProcessStatus) the services answer on a device:
#: audio and voice (speech.py: playback, listener), gui_service (gui.py),
#: PHAL (ovos-phal-plugin-browser). ovos-core's skills and intents report themselves.
_SERVICES = ("audio", "voice", "gui_service", "PHAL")
_statuses = []


def _report_status(bus):
    """Answer mycroft.<service>.is_alive / is_ready for the parts above."""
    from ovos_utils.process_utils import ProcessStatus
    for name in _SERVICES:
        status = ProcessStatus(name, bus=bus)
        status.set_started()
        status.set_alive()
        status.set_ready()
        _statuses.append(status)


#: Bus events the page reacts to itself (the mic hint, follow-up listening).
#: ovos-audio-plugin-browser's commands to the page's <audio> (web/media.js);
#: the page answers with <prefix>state through core_send
_MEDIA_PREFIX = "ovos.audio.browser."

_STATE_TOPICS = {
    "recognizer_loop:wakeword", "recognizer_loop:record_begin",
    "recognizer_loop:record_end", "mycroft.mic.listen",
    "mycroft.mic.mute", "mycroft.mic.unmute",
    "ovos.utterance.handled", "mycroft.skill.handler.complete",
    "complete_intent_failure", "ovos.intent.unmatched",
}


def _watch(raw):
    """Forward the bus events in _STATE_TOPICS to the page."""
    try:
        msg = json.loads(raw) if isinstance(raw, str) else raw.serialize()
    except Exception:
        return
    t = msg.get("type") if isinstance(msg, dict) else None
    if _core_open:   # the new visage's core bus socket gets everything
        _post("core", raw if isinstance(raw, str) else raw.serialize())
    if t in _STATE_TOPICS or (t or "").startswith(_MEDIA_PREFIX) and t != _MEDIA_PREFIX + "state":
        _post("bus", json.dumps({"type": t, "data": msg.get("data", {})}))
    elif t in ("configuration.updated", "configuration.patch", "configuration.patch.clear"):
        # the page's own texts follow OVOS' language (web/i18n.js); read it
        # once ovos-config's handler has applied the change (the control
        # panel sends configuration.patch, a PHAL plugin .updated)
        import asyncio
        asyncio.get_event_loop().call_soon(_post_lang)


def _post_lang():
    from ovos_config import Configuration
    _post("bus", json.dumps({"type": "emkay.lang",
                             "data": {"lang": Configuration().get("lang", "en-US"),
                                      "stt_module": Configuration().get("stt", {}).get("module")}}))


# --- calls from the page -------------------------------------------------

def gui_message(raw: str):
    """A GUI-protocol message from the screen (focus, page events)."""
    gui.client().from_page(raw)


# --- the visage (ovos-gui-visage, Flutter web build) ---------------------
#
# It opens two websockets on a device: the core messagebus and ovos-gui's
# legacy GUI socket (web/visage2-shim.js stands in for both). The GUI socket
# is ovos-gui's stream (gui.py's BrowserGuiClient); the bus socket is every
# bus message, both ways, while it is open.

_core_open = False


def core_open(is_open: bool = True):
    """The new visage's bus socket opened (or closed)."""
    global _core_open
    _core_open = bool(is_open)


def core_send(raw: str):
    """A message the new visage put on the bus, emitted as any bus client's is."""
    from ovos_bus_client.message import Message
    from .browser import hand_over
    msg = Message.deserialize(raw)
    hand_over(lambda: boot.bus().emit(msg))


def gui_sync():
    """A GUI socket (re)connected: replay ovos-gui's state to it, as
    GUIWebsocketHandler.open() does for a new connection."""
    from ovos_gui.bus import GUIWebsocketHandler
    GUIWebsocketHandler.synchronize(gui.client())


def res_file(path: str):
    """A file for the new visage's res/ (ovos-gui's cache, `cache=True`) or
    res-abs/ (an absolute path) route; None if there is no such file."""
    import os
    from pyodide.ffi import to_js
    if path.startswith("res/"):
        from ovos_gui.constants import GUI_CACHE_PATH
        full = os.path.join(GUI_CACHE_PATH, path[4:])
    elif path.startswith("res-abs/"):
        full = "/" + path[8:].lstrip("/")
    else:
        return None
    full = os.path.normpath(full)
    if not os.path.isfile(full):
        return None
    with open(full, "rb") as f:
        return to_js(f.read())


def say(text: str):
    """Typed input: handled exactly like a spoken utterance."""
    from .browser import hand_over
    hand_over(lambda: boot.utterance(text))


def wakeword(name: str):
    """The page heard the wake word: tell OVOS as ovos-dinkum-listener does."""
    boot.emit("recognizer_loop:wakeword", {"utterance": name, "engine": "openwakeword (browser)"})


def record_begin():
    """The page started recording: tell OVOS, so the face starts listening."""
    boot.emit("recognizer_loop:record_begin")


def heard(pcm16, sample_rate=16000) -> str:
    """A finished recording: run STT and hand the text to OVOS.

    `pcm16` is a JS Uint8Array of 16-bit little-endian mono samples.
    Returns the transcription ("" if nothing was understood).
    """
    data = pcm16.to_bytes() if hasattr(pcm16, "to_bytes") else bytes(pcm16)
    return speech.heard(data, int(sample_rate))


def sound_bytes(uri: str):
    """A sound file's bytes for the page (the confirm-listening sound)."""
    from pyodide.ffi import to_js
    return to_js(speech.sound_bytes(uri))


def heard_text(text: str) -> str:
    """Text the browser's own speech recognition heard (ovos-stt-plugin-browser):
    on to OVOS as any STT result goes (speech.heard after its STT step)."""
    return speech.heard_text(text)


def playback_started(ident: str, visemes_json: str = "[]"):
    """The page started playing speech `ident`: the face starts talking."""
    speech.playback_started(ident, json.loads(visemes_json))


def playback_ended(ident: str):
    """The page finished playing speech `ident`."""
    speech.playback_ended(ident)


def phal_position(lat=None, lon=None, error=None):
    """The browser's geolocation answer, for the PHAL plugin (ovos-phal-plugin-browser)."""
    if phal.plugin() is not None:
        phal.plugin().on_position(lat, lon, error)


def phal_event(event, data_json):
    """A change the page saw for the PHAL plugin: online, sensor, picture,
    camera (ovos-phal-plugin-browser)."""
    if phal.plugin() is not None:
        phal.plugin().on_page_event(event, json.loads(data_json))


async def panel_request(method, path, query, headers_json, body):
    """One request for the stock settings panel (see panel.py and sw.js).

    Returns a JS object {status, headers: [[k, v], ...], body: Uint8Array}.
    """
    import js
    from pyodide.ffi import to_js
    status, headers, data = await panel.request(method, path, query, headers_json, body)
    return to_js({"status": status, "headers": json.loads(headers), "body": to_js(data)},
                 dict_converter=js.Object.fromEntries)


def skipped_threads() -> str:
    """Names of the threads that were deferred or left out (diagnostics)."""
    return json.dumps(browser.STARTED)
