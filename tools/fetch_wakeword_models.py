"""Fetch the openWakeWord models the site ships (web/wakeword.js).

From openWakeWord's own release (https://github.com/dscripka/openWakeWord,
v0.5.1): the shared front end (melspectrogram, embedding) and the
pre-trained wake words OVOS can name in `listener.wake_word`. The code of
openWakeWord is Apache-2.0; its pre-trained models are CC BY-NC-SA 4.0.

Usage: python3 tools/fetch_wakeword_models.py OUT_DIR
"""
import sys
import urllib.request
from pathlib import Path

RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/"
FILES = ["melspectrogram.onnx", "embedding_model.onnx",
         "hey_mycroft_v0.1.onnx", "hey_jarvis_v0.1.onnx", "alexa_v0.1.onnx"]

if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        target = out / name
        if not target.exists():
            urllib.request.urlretrieve(RELEASE + name, target)
        print(f"{name}: {target.stat().st_size / 1e6:.1f} MB")
