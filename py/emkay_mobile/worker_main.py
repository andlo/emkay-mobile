"""What the page's Web Worker runs once Python is up.

The worker owns everything OVOS: the bus, ovos-core, ovos-gui and the
listener/audio halves. The page owns the screen, the microphone and the
speaker. They talk through postMessage; this module is the Python end.
"""
import json

from . import boot, browser, gui, speech

_js_post = None   # set by the worker: post(kind, payload)


def _post(kind, payload, data=None):
    """Hand something to the page: payload is a str, data optional bytes."""
    if _js_post is None:
        return
    if data is not None:
        from pyodide.ffi import to_js
        _js_post(kind, payload, to_js(data))   # copied into a Uint8Array
    else:
        _js_post(kind, payload)


def start(js_post, user_config=None):
    """Boot OVOS and wire it to the page. Returns a JSON summary."""
    global _js_post
    _js_post = js_post
    try:
        import pyodide_http
        pyodide_http.patch_all()   # requests/urllib through the browser's XHR
    except ImportError:
        pass
    import time
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


_STATE_TOPICS = {
    "recognizer_loop:wakeword", "recognizer_loop:record_begin",
    "recognizer_loop:record_end", "mycroft.mic.listen",
    "ovos.utterance.handled", "mycroft.skill.handler.complete",
    "complete_intent_failure", "ovos.intent.unmatched",
}


def _watch(raw):
    """Pass the few bus events the page itself reacts to."""
    try:
        msg = json.loads(raw) if isinstance(raw, str) else raw.serialize()
    except Exception:
        return
    t = msg.get("type") if isinstance(msg, dict) else None
    if t in _STATE_TOPICS:
        _post("bus", json.dumps({"type": t, "data": msg.get("data", {})}))


# --- calls from the page -------------------------------------------------

def gui_snapshot():
    return gui.client().snapshot()


def gui_message(raw):
    gui.client().from_page(raw)


def say(text):
    boot.utterance(text)


def record_begin():
    boot.emit("recognizer_loop:record_begin")


def heard(pcm16, sample_rate=16000):
    """pcm16: a JS Uint8Array of 16-bit little-endian mono samples."""
    data = pcm16.to_bytes() if hasattr(pcm16, "to_bytes") else bytes(pcm16)
    return speech.heard(data, int(sample_rate))


def playback_started(ident, visemes_json="[]"):
    speech.playback_started(ident, json.loads(visemes_json))


def playback_ended(ident):
    speech.playback_ended(ident)


def skipped_threads():
    return json.dumps(browser.STARTED)
