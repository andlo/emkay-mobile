"""The Python end of the page's Web Worker.

The worker owns everything OVOS: the bus, ovos-core and its skills, ovos-gui
and the small listener/audio halves (speech.py). The page owns what only a
browser tab can reach: the screen, the microphone and the speaker.

They talk through postMessage. worker.js calls the functions below; Python
answers through the `js_post(kind, payload, data=None)` callable given to
`start()`. The kinds are:

  "gui"    one GUI-protocol message (JSON) for ovos-visage
  "audio"  speech to play: payload is JSON metadata, data the WAV bytes
  "bus"    one of the few bus events the page reacts to itself
"""
import json
import time

from . import boot, browser, gui, settings, speech

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
    bus.on("message", _watch)
    info["skipped_waits"] = browser.SKIPPED_WAITS[:]
    return json.dumps(info)


#: Bus events the page reacts to itself (the mic hint, follow-up listening).
_STATE_TOPICS = {
    "recognizer_loop:wakeword", "recognizer_loop:record_begin",
    "recognizer_loop:record_end", "mycroft.mic.listen",
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
    if t in _STATE_TOPICS:
        _post("bus", json.dumps({"type": t, "data": msg.get("data", {})}))


# --- calls from the page -------------------------------------------------

def gui_snapshot() -> str:
    """The full GUI state, for a newly connected ovos-visage screen."""
    return gui.client().snapshot()


def gui_message(raw: str):
    """A GUI-protocol message from the screen (focus, page events)."""
    gui.client().from_page(raw)


def say(text: str):
    """Typed input: handled exactly like a spoken utterance."""
    boot.utterance(text)


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


def playback_started(ident: str, visemes_json: str = "[]"):
    """The page started playing speech `ident`: the face starts talking."""
    speech.playback_started(ident, json.loads(visemes_json))


def playback_ended(ident: str):
    """The page finished playing speech `ident`."""
    speech.playback_ended(ident)


def export_settings():
    """The settings folder as zip bytes (a JS Uint8Array), see settings.py."""
    from pyodide.ffi import to_js
    return to_js(settings.export_zip())


def import_settings(data) -> str:
    """Replace the settings with an export; returns its manifest as JSON.

    The page reloads afterwards, so OVOS boots with the restored settings.
    """
    raw = data.to_bytes() if hasattr(data, "to_bytes") else bytes(data)
    return json.dumps(settings.import_zip(raw))


def skipped_threads() -> str:
    """Names of the threads that were deferred or left out (diagnostics)."""
    return json.dumps(browser.STARTED)
