# Changing speech settings while Emkay runs

On a device, ovos-dinkum-listener and ovos-audio notice a configuration
change and load the new plugins. Emkay does the same, so a change in the
control panel (or by a skill or PHAL plugin) takes effect without a restart,
and the screen shows what is going on.

| You change | What happens |
|---|---|
| Speech recognition (STT) or voice (TTS) | The new plugin is used from the next sentence. If it has a model to fetch (Whisper, Røst, Piper), the download starts at once, and a line at the top shows it: "Fetching the voice … 45 %", then "The voice is ready". |
| Wake word, or its settings | The page stops the old wake word and starts the new one: "Loading the wake word "hey emkay" …", then "… is ready". |
| Language | Skills, intents and models are loaded for the language when Emkay starts, as on a device, so Emkay says "Switching to English – starting again …" and reloads. |

## Meanwhile

Until a new model is downloaded, Emkay keeps going with what it has, and the
status line says which:

- **the previous plugin** ("The previous voice speaks meanwhile"): the STT or
  TTS from before the change, so going from one local model to another needs
  no server in between
- **the fallback** (`stt.fallback_module` / `tts.fallback_module`, normally
  OpenVoiceOS' servers: "The server's voice speaks meanwhile"), when there was
  no previous one, e.g. right after a start

In "local only" mode ([local-only.md](local-only.md)) there is no server to
fall back on: Emkay waits for the download instead.

A model that is already in the browser's cache loads in a moment and shows
nothing.

## How it works

- [`worker_main.py`](../py/emkay_mobile/worker_main.py) `_settings_changed()`
  runs on `configuration.patch` / `configuration.updated` and compares the
  language, `stt`, `tts`, `listener.wake_word` and its `hotwords` entry with
  what was applied.
- [`speech.py`](../py/emkay_mobile/speech.py) `reload(keep_previous=True)`
  drops the plugins but keeps the old ones as the interim, `prewarm()` starts
  the browser plugins' downloads, and `emkay.speech.interim` tells the page
  what speaks or listens meanwhile.
- [`whisper.js`](../web/whisper.js) and [`piper.js`](../web/piper.js) report
  their downloads (`emkayModelProgress`, worker kind `"model"`).
- [`app.js`](../web/app.js) `modelStatus` draws the status line; `wake.restart()`
  starts the new wake word; a language change goes through `system.reboot`,
  so the PHAL plugin saves to disk before the page reloads.
