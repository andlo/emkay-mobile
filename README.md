# Emkay

A stock [OpenVoiceOS](https://openvoiceos.org) running **in a browser** – on a
phone, a tablet, a TV or a Raspberry Pi in kiosk mode; no app store, no
sideloading, nothing to install – with the Mycroft Mark II Kickstarter face
([ovos-visage](https://github.com/OscillateLabsLLC/ovos-visage)) as the screen.

"Emkay" is "MK" said out loud, a nod to Mycroft's Mark I and Mark II.

> **Status: early alpha.** OVOS core, the installer's 22 default skills,
> ovos-gui with the homescreen and the Mark II face boot in the browser
> (about 2½ minutes the first time on a PC, longer on a phone). A typed or
> spoken question goes the whole way: intent, skill, the public OVOS TTS
> server, sound and the face's mouth. The stock ovos-control-panel opens
> from the ⚙ menu.
>
> Open it: <https://app.emkay.ai/> (built by GitHub Actions). Project page:
> <https://emkay.ai/>.

## What it is

The same OVOS an [ovos-installer](https://github.com/OpenVoiceOS/ovos-installer)
device gets, on the **alpha** channel, compiled to WebAssembly with
[Pyodide](https://pyodide.org):

| Part | What runs |
|---|---|
| Core | `ovos-core[plugins]` – SkillManager, IntentService and the pipeline plugins (m2v, padatious, adapt, …) on an in-process bus |
| Skills | the installer defaults: `ovos-core[skills-essential,skills-internet,skills-audio]` |
| Speech | the installer default (public servers): `ovos-stt-plugin-server`, `ovos-tts-plugin-server` |
| Screen | `ovos-gui` + `ovos-skill-homescreen`, drawn by ovos-visage (the Mark II face) |
| Setup | the stock `ovos-control-panel`, in the ⚙ menu |

See [`requirements/`](requirements) for the exact lists.

Skills install the usual way – they are Python packages, and everything in
`~/.config` and `~/.local` lives in the browser's IndexedDB. The control
panel's Backup page (⚙ → OpenVoiceOS settings) downloads the settings to the
phone and restores them, so they survive clearing the browser.

## How it fits together

```
page (web/app.js)                 Web Worker (web/worker.js + Pyodide)
 ├─ ovos-visage (unmodified) ◄──► BrowserGuiClient ─ ovos-gui ─┐
 ├─ microphone → 16 kHz PCM  ───► speech.heard → STT plugin    ├─ FakeBus ─ ovos-core
 ├─ speaker ◄─ WAV + visemes ◄─── speech.on_speak → TTS plugin ┘            + skills
 └─ menu: OpenVoiceOS settings (the stock control panel), full screen, about
```

- `py/emkay_mobile/boot.py` starts OVOS the way `ovos_core.__main__` does.
- `py/emkay_mobile/gui.py` makes the page a GUI client of ovos-gui; visage's
  own `GuiState` (vendored in `py/ovos_visage`) keeps the screen state.
- `py/emkay_mobile/speech.py` runs whatever STT/TTS plugin `mycroft.conf` names.
- `web/worker.js` downloads the bundle once, caches it, and mounts IndexedDB.

## How the browser differs from a device

We stay as close to OVOS as possible; these are the places where the browser
forces a workaround:

- **No threads.** Pyodide cannot start OS threads. Thread pools run their
  work at once, timers go on the browser event loop, `Event.wait` and
  `time.sleep` return at once, and service loops that never return are not
  started; the event scheduler is driven from the loop instead. A
  `Condition.wait`/`Queue.get` without a timeout raises where it was made
  instead of freezing the page, and ovos-workshop's scheduler-request
  thread is replaced by work on the loop
  ([`browser.py`](py/emkay_mobile/browser.py)).
- **Native packages without a WebAssembly build** (rapidfuzz, PyStemmer,
  pyahocorasick, marisa-trie, psutil, timezonefinder, tokenizers) get small
  pure-Python stand-ins ([`shims/`](py/emkay_mobile/shims)). The tokenizers
  stand-in is checked token for token against the real one
  (`tools/check_tokenizers_shim.py`).
- **m2v uses one model per language** (via the plugin's documented `models`
  setting) instead of the 141 MB multilingual default.
- **Padatious is pre-trained.** Training its networks takes minutes in
  WebAssembly, so [`tools/build_intent_cache.py`](tools/build_intent_cache.py)
  trains them on normal CPython with the same versions, one CI job per
  language, and the phone loads the cache. Padaos' prefilter warm-up is
  skipped (it only speeds queries up).
- **ovos-gui is held at 1.5.4a1** and its websocket server is not started; the
  page is its client directly. 1.6 moved GUI clients to adapter plugins
  (ovos-gui-plugin-visage), which is the way forward once it is released.
- **The phone's "hardware"** is a PHAL plugin whose device is the page
  ([`phal.py`](py/emkay_mobile/phal.py)). Volume answers `mycroft.volume.*`
  exactly like ovos-PHAL-plugin-alsa, with the page's output gain as the
  mixer. Location works like ovos-phal-plugin-ipgeo (assistant config
  layer, `ovos.ipgeo.update`), but from the browser's geolocation, since
  ipgeo's `http://` service cannot be called from an https page; until the
  user allows it, OVOS gets the browser's time zone. It ships as an
  ordinary installed PHAL plugin (`ovos-phal-plugin-browser`, entry point
  `opm.phal`), so the control panel sees it. Also in it, each with the bus
  contract of the plugin a device uses:
  - power, factory reset and language as ovos-PHAL-plugin-system
    ([`phal_system.py`](py/emkay_mobile/phal_system.py)): reboot and
    "restart the services" reload the page, shutdown darkens it until
    tapped, factory reset wipes what the system plugin wipes and starts
    over; there is no SSH;
  - connectivity as ovos-PHAL-plugin-connectivity-events, from the
    browser's online/offline state ([`phal_device.py`](py/emkay_mobile/phal_device.py));
  - the phone's sensors as ovos-PHAL-sensors reports them
    (`ovos.phal.sensor`, shown on the control panel's Sensors page):
    battery and charging, network type and speed, screen on and
    orientation, moving or still, how the phone lies (face up, face down,
    upright), compass direction, ambient light, storage, memory and CPU
    cores – whichever the browser has, and only when a value changes;
  - the camera as ovos-PHAL-plugin-camera (`ovos.phal.camera.*`), except
    that `b64_frame` is a JPEG rather than OpenCV's raw pixel buffer.
  The page side is [`device.js`](web/device.js).
- **Speech to text** is OVOS' configured STT plugin, as on a device
  (the public OVOS servers by default). One more plugin ships with the
  site: **ovos-stt-plugin-browser**, the browser's own speech recognition
  (Web Speech API – Google's in Chrome on Android, Apple's on an iPhone),
  picked in the control panel like any other STT
  ([`stt_browser.py`](py/emkay_mobile/stt_browser.py)). It handles languages
  the public servers do not (Danish, for one) and shows the words as you
  speak; the audio goes to Google or Apple. The browser listens itself, so
  Emkay lets the microphone go meanwhile; where the browser has no speech
  recognition (Firefox), `stt.fallback_module` transcribes the recording.
- **The wake word** is OVOS' own `listener.wake_word` ("hey_mycroft" by
  default; "hey_jarvis" and "alexa" also work), heard by
  [openWakeWord](https://github.com/dscripka/openWakeWord) with its own
  models and streaming pipeline, ported to the browser
  ([`wakeword.js`](web/wakeword.js), onnxruntime-web, a Web Worker of its
  own). The microphone stays open while Emkay is on screen – a phone or
  tablet used as an assistant is usually on its charger – and listening
  pauses while Emkay records, speaks or is muted. Hearing it does what
  ovos-dinkum-listener does (`recognizer_loop:wakeword`, then listen).
  Tapping the screen still works. The browser's noise suppression and
  automatic gain are off (they distort speech); echo cancellation is on.
  openWakeWord's code is Apache-2.0, its pre-trained models CC BY-NC-SA 4.0
  (non-commercial).
- **The listener's microphone controls** (`mycroft.mic.get_status`, `mute`,
  `unmute`) are answered as ovos-dinkum-listener does; a muted mic does not
  listen.
- **The control panel has no port to listen on.** The stock FastAPI app is
  built with `create_app(bus=..., connect_bus=False)`, as its own tests do,
  and called as ASGI inside the worker ([`panel.py`](py/emkay_mobile/panel.py));
  a Service Worker ([`sw.js`](web/sw.js)) is its network. It prefixes the
  panel's absolute links when the site lives below a path, sets
  `Sec-Fetch-Site` honestly for the panel's cross-site check, lets this
  one site show it in a frame (it forbids all frames otherwise), and gives
  it Emkay's colours through its own CSS variables. A Service Worker's
  responses cannot set cookies, so the Emkay page keeps the panel's sign-in
  cookie for it ([`app.js`](web/app.js)). Pages for hardware a phone does
  not have (Wi-Fi, Mark 1 faceplate, sensors, desktop apps) are left out of
  its menu. The panel is only reachable on the phone itself: a browser tab
  cannot listen on the network.
- **Installing skills** goes through ovos-core's own installer
  (`ovos.pip.install`, also what the control panel's Plugins page uses);
  only the one place it starts pip is replaced
  ([`pip.py`](py/emkay_mobile/pip.py)), since a browser cannot run
  processes. It resolves against OVOS' alpha constraints, takes pure-Python
  wheels from PyPI and unpacks them into `~/.local/lib/python3.14/site-packages`
  (IndexedDB, so they survive a reload). SkillManager then loads the new
  skill at once, as on a device. Packages that ship with the site cannot be
  removed, and a skill whose service only answers on `http://` or without
  CORS will install but cannot reach it from the browser.
- **Speaking** is ovos-audio's speak handler without its playback queue
  ([`speech.py`](py/emkay_mobile/speech.py)): ovos-audio's own dialog
  transformer service, the configured TTS, ovos-audio's TTS transformer
  service on the WAV, then the page plays it. Transformers are set up in
  `mycroft.conf` (`dialog_transformers`, `tts_transformers`) or the control
  panel and, as on a device, load when the audio side starts.
- **Language:** the site ships the OVOS languages with 80 % or more of the
  skills translated (en-US, da-DK, de-DE, fr-FR, it-IT, es-ES, gl-ES, ca-ES,
  eu-ES, pt-PT, pt-BR, nl-NL). OVOS' default language is the phone's, when
  it is one of them, else OVOS' own en-US. It is written to the assistant
  layer, as ipgeo does with the location, so a language chosen in the
  control panel always wins. A phone downloads only the pre-trained intents
  and m2v model of the language OVOS boots in; a newly chosen language is
  fetched with a restart, which Emkay offers. Languages OpenVoiceOS has no
  m2v model for (fr, it) run without the m2v pipeline. Emkay's own few
  words (start screen, menu) follow OVOS' language, and the phone's until
  OVOS is up; they are in [`locale/`](locale), one `.dialog` file per text
  as in an OVOS skill.
- **First start** offers the control panel's own setup wizard next to
  starting on the defaults. Its recommendations are limited to plugins that
  run in a browser, and its wake word step is hidden for now.
- **Config changes are followed over the bus** (`configuration.updated`),
  as the services on a device do; the file watcher thread is left out.
- **On a phone** the screen fills the display; on a larger screen visage
  draws the whole Mark II around it.
- **Left out:** `ovos-skill-boot-finished` (waits for an audio service and a
  listener that do not exist here).
- **Added to the "ovos" skill profile:** skills that answer without a server
  (calculator, geography, geometry, NATO alphabet, Morse code), and
  reading aloud: `ovos-common-reading-pipeline-plugin` with the providers
  whose sources a browser may read (the OpenVoiceOS blog, horoscopes). A
  browser can only fetch from sites that allow it (CORS), and public
  servers fail more often than a device notices. The pipeline plugin is put
  into OVOS' pipeline where its README says, once; the setup page can move it.
- **Waiting works as with threads** where the browser has JavaScript Promise
  Integration (JSPI: Chrome and Edge 137+, Firefox 153+, Safari 27+, and their
  Android/iOS versions): a `time.sleep`
  or `Event.wait` suspends Python where it is while the worker goes on with
  the page's messages, so a skill that asks back (`get_response`: "for
  when?", "is it that one?", yes/no, quizzes) gets the answer, and `stop`
  reaches a skill that is reading aloud. Without JSPI (older browsers)
  waits return at once, and a question back is asked but not waited
  for ([#20](https://github.com/emkay-voice/emkay/issues/20)).

## The skill store

[store.emkay.ai](https://store.emkay.ai) ([emkay-voice/store](https://github.com/emkay-voice/store))
lists the OVOS skills Emkay can use, by category and in the visitor's language.
Its "Get" opens `app.emkay.ai/?install=<package>`: Emkay opens the control
panel's Plugins page searched for that package, and the panel's own Install
button installs it (Emkay installs nothing on a link's say-so).

## Versions and releases

app.emkay.ai is always the newest build of `main`. The boot screen and
*About Emkay* show which one: `Emkay 0.1.0 · build 123 · abc1234` (the
[VERSION](VERSION) file, the CI run, the commit), so a report can name it.
A release names a tested point: set VERSION, tag `vX.Y.Z` and push; the
release workflow makes the GitHub release with the commits since the last
tag as notes.

## Developing

```bash
npm install --include=dev            # Pyodide, for Node runs
python3 -m pip wheel --pre -w wheelhouse -r requirements/browser.txt
python3 -m pip wheel --pre --no-deps -w wheelhouse \
    -r requirements/browser-nodeps.txt -r requirements/browser-emscripten.txt
python3 tools/wheelplan.py wheelhouse node_modules/pyodide/pyodide-lock.json > plan.json

# pre-train padatious (normal CPython venv with requirements/browser*.txt,
# minus ovos-m2v-pipeline), fetch the m2v and wake word models
python tools/build_intent_cache.py build/intent_cache en-US da-DK
python tools/fetch_m2v_models.py build/m2v en-US da-DK
python tools/fetch_wakeword_models.py build/oww

# build and serve the site on http://127.0.0.1:8080/
EMKAY_M2V=build/m2v EMKAY_OWW=build/oww python3 tools/build_site.py wheelhouse plan.json build/intent_cache
python3 tools/serve.py

# or run OVOS in Pyodide under Node
node tools/node_smoke.mjs wheelhouse plan.json "what time is it"
```

`tools/probes/` holds measurement scripts for `tools/node_run.mjs` and the
headless-browser tests (`*_browser.mjs`). `tools/probes/ci.py` serves the built
site and runs the browser tests, as CI does before every deploy:

```bash
CHROME=/path/to/chrome python3 tools/probes/ci.py
```

### Adding a language

1. Add it to `matrix.lang` in [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
   CI pre-trains padatious for it and fetches its m2v model, if OpenVoiceOS
   publishes one (`tools/fetch_m2v_models.py`).
2. Translate Emkay's own texts: copy [`locale/en-us/`](locale/en-us) to
   `locale/<lang>/` (lower case, e.g. `pt-br`) and translate each `.dialog`
   file, keeping the `{placeholders}`. The build gathers them into
   `texts.json` for [`i18n.js`](web/i18n.js); a language without its own
   folder falls back to one with the same base language, then English.

The texts are laid out like a skill's dialogs so that OVOS' translation
tooling (ovos-localize) can take them over once Emkay lives under
OpenVoiceOS.

## License

Apache-2.0
