"""The two halves a device runs outside ovos-core, in their smallest form.

ovos-dinkum-listener: the page records an utterance (the browser owns the
microphone) and hands over 16 kHz mono PCM; the configured STT plugin turns it
into text, which goes on the bus as recognizer_loop:utterance.

ovos-audio: on "speak", the configured TTS plugin makes a WAV, which the page
plays (the browser owns the speaker). The page reports when playback starts
and ends, and this side emits the same bus events ovos-audio does, so the
GUI face listens, talks and rests like on a device.

Both plugins come from mycroft.conf through the plugin manager, exactly as on
a device, so the installer default (public ovos-stt/tts servers) and anything
the setup page writes are used unchanged.
"""
import os
import re
import tempfile
import time

_stt = None
_tts = None
_post_audio = None   # callable(wav_bytes, meta_dict) into the page
_pending = {}        # ident -> speak message, while the page plays it


def _config():
    from ovos_config import Configuration
    return Configuration()


def stt():
    global _stt
    if _stt is None:
        from ovos_plugin_manager.stt import OVOSSTTFactory
        _stt = OVOSSTTFactory.create(_config())
    return _stt


def tts():
    global _tts
    if _tts is None:
        from ovos_plugin_manager.tts import OVOSTTSFactory
        _tts = OVOSTTSFactory.create(_config())
    return _tts


def reload():
    """Drop the plugins so the next use reads mycroft.conf again."""
    global _stt, _tts
    _stt = _tts = None


# --- listener half ------------------------------------------------------

def transcribe(pcm16: bytes, sample_rate: int = 16000, lang: str = None) -> str:
    from ovos_plugin_manager.utils.audio import AudioData
    lang = lang or _config().get("lang", "en-US")
    audio = AudioData(pcm16, sample_rate, 2)
    t = time.time()
    text = stt().execute(audio, language=lang) or ""
    print(f"[emkay] stt {time.time() - t:.1f}s: {text!r}")
    return text.strip()


def heard(pcm16: bytes, sample_rate: int = 16000):
    """What the listener does after a recording ends."""
    from . import boot
    bus = boot.bus()
    from ovos_bus_client.message import Message
    lang = _config().get("lang", "en-US")
    bus.emit(Message("recognizer_loop:record_end"))
    text = transcribe(pcm16, sample_rate, lang)
    if not text:
        bus.emit(Message("recognizer_loop:speech.recognition.unknown"))
        return ""
    boot.utterance(text, lang=lang)
    return text


# --- audio half ---------------------------------------------------------

_VISEME_OF = [  # rough letter-to-mouth table, codes from ovos_utils visimes
    (re.compile(r"[bpm]"), "4"), (re.compile(r"[fv]"), "5"),
    (re.compile(r"[ouw]"), "2"), (re.compile(r"[aei]"), "0"),
    (re.compile(r"[a-z]"), "3"),
]


def text_visemes(text: str, seconds: float):
    """Visemes from the text when the TTS gives no phonemes (Piper over HTTP
    does not). Spread evenly over the audio, it is enough for the face."""
    letters = [c for c in text.lower() if c.isalpha() or c in " ,.!?"]
    if not letters or seconds <= 0:
        return []
    step = seconds / len(letters)
    out, t = [], 0.0
    for c in letters:
        t += step
        code = "4"
        for pat, v in _VISEME_OF:
            if pat.match(c):
                code = v
                break
        if out and out[-1][0] == code:
            out[-1][1] = round(t, 3)
        else:
            out.append([code, round(t, 3)])
    return out


def _wav_seconds(data: bytes) -> float:
    import io
    import wave
    try:
        with wave.open(io.BytesIO(data)) as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def on_speak(message):
    """ovos-audio's speak handler, minus the playback queue."""
    utterance = message.data.get("utterance", "")
    if not utterance or _post_audio is None:
        return
    lang = message.data.get("lang") or _config().get("lang", "en-US")
    ident = message.context.get("ident") or f"{time.time():.6f}"
    t = time.time()
    try:
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        path, phonemes = tts().get_tts(utterance, path, lang=lang)
        with open(path, "rb") as f:
            data = f.read()
        os.unlink(path)
    except Exception as e:
        print(f"[emkay] tts failed: {e!r}")
        from ovos_bus_client.message import Message
        message.forward("ovos.audio.output.error", {"error": repr(e)})
        return
    seconds = _wav_seconds(data)
    visemes = None
    if phonemes:
        try:
            visemes = [[str(c), float(d)] for c, d in tts().viseme(phonemes)]
        except Exception:
            visemes = None
    visemes = visemes or text_visemes(utterance, seconds)
    _pending[ident] = message
    print(f"[emkay] tts {time.time() - t:.1f}s for {seconds:.1f}s of audio")
    _post_audio(data, {"ident": ident, "utterance": utterance,
                       "seconds": seconds, "visemes": visemes})


def playback_started(ident: str, visemes=None):
    from ovos_bus_client.message import Message
    msg = _pending.get(ident) or Message("speak")
    from . import boot
    boot.bus().emit(msg.forward("recognizer_loop:audio_output_start"))
    if visemes:
        boot.bus().emit(msg.forward("enclosure.mouth.viseme_list",
                                    {"start": time.time(), "visemes": visemes}))


def playback_ended(ident: str):
    from . import boot
    from ovos_bus_client.message import Message
    msg = _pending.pop(ident, None) or Message("speak")
    boot.bus().emit(msg.forward("recognizer_loop:audio_output_end"))
    if msg.data.get("expect_response"):
        boot.bus().emit(msg.forward("mycroft.mic.listen"))


_recent = {}


def _once(m):
    """The bus mirrors "speak" and "ovos.utterance.speak"; speak once."""
    m = _as_message(m)
    key = (m.data.get("utterance"), m.context.get("ident"))
    now = time.time()
    if now - _recent.get(key, 0) < 2.0:
        return
    _recent[key] = now
    on_speak(m)


def start(bus, post_audio):
    global _post_audio
    _post_audio = post_audio
    bus.on("speak", _once)
    bus.on("ovos.utterance.speak", _once)


def _as_message(m):
    from ovos_bus_client.message import Message
    return Message.deserialize(m) if isinstance(m, str) else m
