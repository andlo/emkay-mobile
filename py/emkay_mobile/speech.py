"""The two halves a device runs outside ovos-core, in their smallest form.

ovos-dinkum-listener: the page records an utterance (the browser owns the
microphone) and hands over 16 kHz mono PCM; the configured STT plugin turns it
into text, which goes on the bus as recognizer_loop:utterance.

ovos-audio: on "speak", the dialog transformers may rewrite the sentence,
the configured TTS plugin makes a WAV and the TTS transformers may change it;
the page plays it (the browser owns the speaker). The transformers are
ovos-audio's own services (ovos_audio.transformers), run where ovos-audio
runs them. The page reports when playback starts
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
_dialog_tx = None    # ovos-audio's DialogTransformersService
_tts_tx = None       # ovos-audio's TTSTransformersService


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


def transformers():
    """ovos-audio's two transformer stages, loaded once as ovos-audio does.

    Like on a device they read `dialog_transformers` and `tts_transformers`
    from mycroft.conf when the audio service starts; a newly installed or
    enabled transformer is used after a restart (here: a reload of the page).
    """
    global _dialog_tx, _tts_tx
    if _dialog_tx is None:
        from ovos_audio.transformers import DialogTransformersService, TTSTransformersService
        from . import boot
        _dialog_tx = DialogTransformersService(boot.bus())
        _tts_tx = TTSTransformersService(boot.bus())
    return _dialog_tx, _tts_tx


_fallback = None


def _get_tts(utterance, path, lang):
    """The configured TTS; if it fails, `tts.fallback_module`, as ovos-audio
    does. A plugin that runs on the phone (Piper) can fail where a server
    plugin does not: its voice still downloading, no network for that first
    download, a language it has no voice for."""
    global _fallback
    try:
        return tts().get_tts(utterance, path, lang=lang)
    except Exception as e:
        cfg = _config().get("tts", {})
        name = cfg.get("fallback_module") or "ovos-tts-plugin-server"
        if name == cfg.get("module"):
            raise
        print(f"[emkay] tts failed ({e!r}); using the fallback {name}")
        if _fallback is None:
            from ovos_plugin_manager.tts import OVOSTTSFactory
            _fallback = OVOSTTSFactory.create({"tts": {"module": name, name: cfg.get(name, {}),
                                                       "lang": _config().get("lang")}})
        return _fallback.get_tts(utterance, path, lang=lang)


def reload():
    """Drop the plugins so the next use reads mycroft.conf again."""
    global _stt, _tts, _dialog_tx, _tts_tx, _fallback
    _stt = _tts = _fallback = None
    for service in (_dialog_tx, _tts_tx):
        try:
            service and service.shutdown()
        except Exception:
            pass
    _dialog_tx = _tts_tx = None


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
    if _mic_muted:   # muted while recording: hear nothing, as a muted listener
        return ""
    from . import boot
    bus = boot.bus()
    from ovos_bus_client.message import Message
    lang = _config().get("lang", "en-US")
    bus.emit(Message("recognizer_loop:record_end"))
    text = transcribe(pcm16, sample_rate, lang)
    if not text:
        bus.emit(Message("recognizer_loop:speech.recognition.unknown"))
        return ""
    from .browser import hand_over
    hand_over(lambda: boot.utterance(text, lang=lang))   # as the listener: on the bus, back to listening
    return text


def heard_text(text: str) -> str:
    """The browser's speech recognition (ovos-stt-plugin-browser) heard `text`:
    the rest of heard(), as after an STT plugin."""
    if _mic_muted:
        return ""
    from . import boot
    from ovos_bus_client.message import Message
    lang = _config().get("lang", "en-US")
    bus = boot.bus()
    bus.emit(Message("recognizer_loop:record_end"))
    text = (text or "").strip()
    if not text:
        bus.emit(Message("recognizer_loop:speech.recognition.unknown"))
        return ""
    print(f"[emkay] stt (browser): {text!r}")
    from .browser import hand_over
    hand_over(lambda: boot.utterance(text, lang=lang))   # as the listener: on the bus, back to listening
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
    """ovos-audio's speak handler, minus the playback queue.

    In ovos-audio's order: dialog transformers (service.py, handle_speak:
    skipped for skills in their blacklist and for speech with no skill),
    TTS, then the TTS transformers on the WAV file (playback.py, _play).
    """
    utterance = message.data.get("utterance", "")
    if not utterance or _post_audio is None:
        return
    message.context = message.context or {}
    lang = message.data.get("lang") or _config().get("lang", "en-US")
    ident = message.context.get("ident") or f"{time.time():.6f}"
    t = time.time()
    try:
        from ovos_bus_client.session import SessionManager
        dialog_tx, tts_tx = transformers()
        skill_id = message.data.get("meta", {}).get("skill") or message.context.get("skill_id")
        if skill_id and skill_id not in dialog_tx.blacklisted_skills:
            changed, message.context = dialog_tx.transform(
                dialog=utterance, context=message.context, sess=SessionManager.get(message))
            if changed != utterance:
                print(f"[emkay] dialog transformed to: {changed}")
                utterance = changed
    except Exception as e:   # as in ovos-audio: a transformer never stops speech
        print(f"[emkay] dialog transformers failed: {e!r}")
    try:
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        path, phonemes = _get_tts(utterance, path, lang)
        try:
            out, message.context = tts_tx.transform(path, message.context)
            if out and out != path:
                os.unlink(path)
                path = out.replace("file://", "")
        except Exception as e:
            print(f"[emkay] tts transformers failed: {e!r}")
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


#: The listener's mute state, as ovos-dinkum-listener keeps it (not saved:
#: a device's listener also starts unmuted).
_mic_muted = False


def _mic_status(message):
    """mycroft.mic.get_status: answer like ovos-dinkum-listener does."""
    _bus.emit(_as_message(message).response({"muted": _mic_muted}))


def _mic_mute(_message=None):
    """mycroft.mic.mute: stop listening (the page greys its mic out)."""
    global _mic_muted
    _mic_muted = True


def _mic_unmute(_message=None):
    """mycroft.mic.unmute: listen again."""
    global _mic_muted
    _mic_muted = False


def mic_muted() -> bool:
    return _mic_muted


_bus = None


def resolve_sound(uri: str) -> str:
    """A sound's file, found as ovos-audio finds it (_resolve_sound_uri):
    "snd/..." from ovos-audio's own resources, else OVOS' resource lookup."""
    if uri.startswith("snd/") or uri.startswith("snd\\"):
        import ovos_audio
        local = os.path.join(os.path.dirname(ovos_audio.__file__), "res", uri)
        if os.path.isfile(local):
            return local
    from ovos_utils.file_utils import resolve_resource_file
    found = resolve_resource_file(uri)
    if not found or not os.path.exists(found):
        raise FileNotFoundError(f"could not resolve sound uri: {uri}")
    return found


def sound_bytes(uri: str) -> bytes:
    """The bytes of a sound (the page keeps the confirm-listening sound)."""
    with open(resolve_sound(uri), "rb") as f:
        return f.read()


def on_play_sound(message):
    """ovos-audio's instant sound (mycroft.audio.play_sound / ovos.audio.play_sound):
    a sound file, or hex data, played at once - here by the page, over speech."""
    import binascii
    message = _as_message(message)
    key = ("sound", message.data.get("uri"), message.context.get("ident"))
    now = time.time()
    if now - _recent.get(key, 0) < 0.5:   # the bus mirrors the two topic names
        return
    _recent[key] = now
    try:
        if message.data.get("binary_data"):
            data = binascii.unhexlify(message.data["binary_data"])
        else:
            data = sound_bytes(message.data.get("uri") or "")
    except Exception as e:
        print(f"[emkay] play_sound: {e}")
        return
    if _post_audio is not None:
        _post_audio(data, {"sound": True, "uri": message.data.get("uri")})
    from . import boot
    boot.bus().emit(message.response({}))


def start(bus, post_audio):
    global _post_audio, _bus
    _post_audio = post_audio
    _bus = bus
    bus.on("speak", _once)
    bus.on("ovos.utterance.speak", _once)
    bus.on("mycroft.audio.play_sound", on_play_sound)
    bus.on("ovos.audio.play_sound", on_play_sound)
    # the listener's microphone controls (ovos-dinkum-listener's messages)
    bus.on("mycroft.mic.get_status", _mic_status)
    bus.on("mycroft.mic.mute", _mic_mute)
    bus.on("mycroft.mic.unmute", _mic_unmute)


def _as_message(m):
    from ovos_bus_client.message import Message
    return Message.deserialize(m) if isinstance(m, str) else m
