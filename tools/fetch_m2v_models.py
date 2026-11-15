"""Fetch the m2v intent models the site ships, one folder per language.

ovos-m2v-pipeline loads OpenVoiceOS/ovos-m2v-intents-multilingual (int8,
141 MB) for every language unless its documented "models" map says
otherwise. A phone gets one small folder per language instead, chosen from
what OpenVoiceOS publishes:

  en  OpenVoiceOS/ovos-m2v-intents-en, int8   (the English model mycroft.conf
                                               suggests)
  xx  OpenVoiceOS/ovos-m2v-intents-multilingual, folder xx  (per-language
                                               copies of the default model)

A language without a model there is skipped (boot.py then leaves the m2v
pipeline out while OVOS runs in it).

Usage: python3 tools/fetch_m2v_models.py OUT_DIR lang [lang ...]
"""
import shutil
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

MULTI = "OpenVoiceOS/ovos-m2v-intents-multilingual"
CHOICES = {"en": ("OpenVoiceOS/ovos-m2v-intents-en", "int8")}
FILES = ["config.json", "head.safetensors", "labels.json", "model.safetensors",
         "modules.json", "tokenizer.json"]


def fetch(lang, out: Path):
    primary = lang.split("-")[0].lower()
    repo, folder = CHOICES.get(primary, (MULTI, primary))
    snap = Path(snapshot_download(repo, allow_patterns=[f"{folder}/{f}" for f in FILES]))
    src = snap / folder
    if not (src / "model.safetensors").exists():
        # not every language has one (e.g. fr, it): the site then ships none,
        # and boot._m2v_without_model leaves the m2v pipeline out for it
        print(f"{lang}: {repo} has no {folder}/ model - skipped")
        return
    dst = out / primary
    shutil.rmtree(dst, ignore_errors=True)
    dst.mkdir(parents=True)
    for f in FILES:
        if (src / f).exists():
            shutil.copy(src / f, dst / f)
    (dst / "SOURCE").write_text(f"{repo} {folder}\n")
    mb = sum(p.stat().st_size for p in dst.iterdir()) / 1e6
    print(f"{lang}: {repo}/{folder} -> {dst} ({mb:.1f} MB)")


if __name__ == "__main__":
    out = Path(sys.argv[1])
    for lang in sys.argv[2:]:
        fetch(lang, out)
