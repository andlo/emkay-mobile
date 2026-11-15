"""Fetch the wake word engines' models (and code) the site ships (web/wakeword.js).

Emkay hears the wake word the way OVOS' listener would with the plugin
OVOS' config names for it (hotwords.<name>.module):

* ovos-ww-plugin-precise-onnx (OVOS' default for "hey mycroft"): Mycroft
  Precise models from OpenVoiceOS/precise-lite-models, run with
  precise-onnx-js (TigreGotico: a port of that plugin's inference to the
  browser, Apache-2.0), pinned to PRECISE_JS_COMMIT. Into OUT_DIR/precise/.
* ovos-ww-plugin-openwakeword: openWakeWord's own release
  (https://github.com/dscripka/openWakeWord, v0.5.1): the shared front end
  (melspectrogram, embedding) and the pre-trained wake words. The code of
  openWakeWord is Apache-2.0; its pre-trained models are CC BY-NC-SA 4.0.

Usage: python3 tools/fetch_wakeword_models.py OUT_DIR
"""
import sys
import urllib.request
from pathlib import Path

RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/"
FILES = ["melspectrogram.onnx", "embedding_model.onnx",
         "hey_mycroft_v0.1.onnx", "hey_jarvis_v0.1.onnx", "alexa_v0.1.onnx"]

PRECISE_JS_COMMIT = "8a408dba8f5d66745196a8d8c3405d407ebb04a9"
PRECISE_JS = f"https://raw.githubusercontent.com/TigreGotico/precise-onnx-js/{PRECISE_JS_COMMIT}/"
PRECISE_JS_FILES = ["src/mfcc.js", "src/wakeword.js", "LICENSE"]

#: Precise models by the URL OVOS' config gives them (hotwords.*.model), as
#: precise-lite-models' raw files; the page maps a configured URL to the copy.
PRECISE_MODELS = {
    "https://github.com/OpenVoiceOS/precise-lite-models/raw/master/wakewords/en/hey_mycroft.onnx":
        "en/hey_mycroft.onnx",
}
PRECISE_RAW = "https://raw.githubusercontent.com/OpenVoiceOS/precise-lite-models/master/wakewords/"


def get(url: str, target: Path):
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, target)
    print(f"{target}: {target.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        get(RELEASE + name, out / name)
    for name in PRECISE_JS_FILES:
        get(PRECISE_JS + name, out / "precise" / Path(name).name)
    for local in PRECISE_MODELS.values():
        get(PRECISE_RAW + local, out / "precise" / local)
    # which configured model URL is which local file (the page reads it)
    import json
    (out / "precise" / "models.json").write_text(json.dumps(PRECISE_MODELS, indent=1))
