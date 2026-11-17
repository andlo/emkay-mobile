# Local only

Say "go offline" ("gå offline") and Emkay runs *local only*: nothing you say
leaves the phone. "Go online" switches back, and "are you online?" tells you
which it is. A small shield on the screen shows it while it is on. The
state is kept, so it lasts across restarts. (#23)

## What changes

| | online (default) | local only |
|---|---|---|
| speech recognition | what you chose; by default `ovos-stt-plugin-whisper-browser` (Whisper, or Røst for Danish, in the phone), with OpenVoiceOS' servers as the fallback | `ovos-stt-plugin-whisper-browser`, no fallback: it waits for its model |
| voice | what you chose; by default `ovos-tts-plugin-piper-browser` (Piper in the phone), with the servers as the fallback | `ovos-tts-plugin-piper-browser`, no fallback |
| network | everything (skills reach their services) | refused, except Emkay's own site and GET downloads of the models and voices above |

With the defaults, speech already stays on the phone; local only also
closes the network for everything else (Wikipedia, the weather, …), and
takes the servers away as a fallback.

The first time, the speech model and the voice are downloaded once (that is
the one thing still allowed out, and it carries nothing you said); after
that they come from the browser's cache. Online, Emkay lets the server
speak while a voice downloads; local only it waits for the download instead
(`wait_for_download` in both plugins), so the first answer can take a little
longer. Refused requests are in the
network log with `"blocked": true`, so you can see what tried
([network-log.md](network-log.md)). Skills that need the internet (weather,
Wikipedia, radio) say they can't reach it; local skills (time, timers,
calculator, the offline wiki) keep working.

Switching back restores the STT and TTS you had before.

## How it works

OVOS style: the skill only sends bus messages, and a PHAL plugin does the
part that depends on the hardware, so other devices can offer the same.

    ovos.local_only          {"enabled": bool}
    ovos.local_only.status   {}
    -> <type>.response       {"enabled": bool, "stt": module, "tts": module}
    ovos.local_only.changed  {"enabled": bool, "stt": module, "tts": module}

- [ovos-skill-guardian](https://github.com/emkay-voice/ovos-skill-guardian)
  has the intents, in all of Emkay's languages. Without an answer it says
  the device can't.
- [ovos-phal-plugin-browser](https://github.com/emkay-voice/ovos-phal-plugin-browser)
  (`local_only.py`) answers: it changes `stt`/`tts` in the user mycroft.conf
  (and keeps the old ones under `local_only.online`), reloads speech
  (`speech.reload`, passed in by [`worker_main.py`](../py/emkay_mobile/worker_main.py)),
  tells the network layer and asks the page for the shield.
- [`web/netlog.js`](../web/netlog.js) refuses the requests
  (`setLocalOnly`, reached from Python as `js.emkayNet`): `fetch` fails with a
  `TypeError` and XHR with a network error, as when the phone is offline.
- [`web/app.js`](../web/app.js) shows `#offline-shield`.

The kiosk commands (ovos-skill-kiosk: full screen, keep the screen on,
install as an app) go the same way through the PHAL plugin.
