# Emkay Mobile

A stock [OpenVoiceOS](https://openvoiceos.org) running **in your phone's browser** –
no app store, no sideloading – with the Mycroft Mark II Kickstarter face
([ovos-visage](https://github.com/OscillateLabsLLC/ovos-visage)) as the screen.

"Emkay" is "MK" said out loud, a nod to Mycroft's Mark I and Mark II.

> **Status: work in progress, nothing to try yet.** The OVOS core and the
> installer's default skills boot in Pyodide; speech, the face and the setup
> page are being wired up.

## What it is

The same OVOS an [ovos-installer](https://github.com/OpenVoiceOS/ovos-installer)
device gets, on the **alpha** channel, compiled to WebAssembly with
[Pyodide](https://pyodide.org):

| Part | What runs |
|---|---|
| Core | `ovos-core[plugins]` – SkillManager, IntentService and pipeline plugins on an in-process bus |
| Skills | the installer defaults: `ovos-core[skills-essential,skills-internet,skills-audio]` |
| Speech | the installer default (public servers): `ovos-stt-plugin-server`, `ovos-tts-plugin-server` |
| Screen | `ovos-gui` + homescreen, with ovos-visage drawing the Mark II face |
| Setup | the stock `ovos-control-panel` |

See [`requirements/browser.txt`](requirements/browser.txt) for the exact list.

## How the browser differs from a device

- **No threads.** Pyodide cannot start OS threads. Thread pools run their
  work at once, timers go on the browser event loop, and service loops that
  never return are not started ([`py/emkay_mobile/browser.py`](py/emkay_mobile/browser.py)).
- **A few native packages have no WebAssembly build yet** (rapidfuzz,
  PyStemmer, pyahocorasick, marisa-trie, psutil, timezonefinder). Small
  pure-Python stand-ins take their place ([`py/emkay_mobile/shims`](py/emkay_mobile/shims)).
- **Left out:** the m2v intent pipeline (needs `tokenizers`) and
  `ovos-skill-boot-finished` (waits for an audio service and listener).
- **Pre-trained intents.** Padatious trains a neural net per intent, which
  takes minutes in WebAssembly. [`tools/build_intent_cache.py`](tools/build_intent_cache.py)
  trains it on a normal CPython with the same versions, one job per language,
  and the browser loads that cache.
- **ovos-gui is held at 1.5.4a1.** 1.6.0a1 moved GUI clients to adapter
  plugins, and the legacy adapter ovos-visage speaks is not on PyPI yet.

## Developing

```bash
npm install                       # Pyodide for the Node smoke test
python3 -m pip wheel --pre -w wheelhouse -r requirements/browser.txt
python3 -m pip wheel --pre --no-deps -w wheelhouse -r requirements/browser-nodeps.txt -r requirements/browser-emscripten.txt
python3 tools/wheelplan.py wheelhouse node_modules/pyodide/pyodide-lock.json > plan.json
node tools/node_smoke.mjs wheelhouse plan.json "what time is it"
```

## License

Apache-2.0
