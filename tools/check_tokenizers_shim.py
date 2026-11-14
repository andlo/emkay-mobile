"""Compare the pure-Python tokenizers stand-in with the real package.

Usage: python3 tools/check_tokenizers_shim.py TOKENIZER_JSON [...]
       (in a venv that has the real `tokenizers`)

Feeds both the same sentences: a fixed set plus every intent template the
installed OVOS skills ship (locale/*/*.intent), and reports how many token
id sequences differ.
"""
import importlib.util
import json
import sys
from pathlib import Path

import tokenizers as real

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "shim_tokenizers", REPO / "py/emkay_mobile/shims/tokenizers/__init__.py")
shim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shim)

FIXED = [
    "what time is it", "What's the weather like in Copenhagen?", "set a timer for 10 minutes",
    "hvad er klokken", "Hvordan bliver vejret i morgen i Kvistgård?", "sæt en alarm til kl. 7:30",
    "Æblegrød med flødeskum, øl og ålen", "naïve café – “quotes” and ‘single’ … ellipsis",
    "tell me about Marie Curie", "spell bureaucracy", "  leading   and trailing  ", "",
    "1234 + 56 = 1290", "Ünïcödé façade résumé", "ﬁ ligature and Ｆｕｌｌ width", "emoji 😀 test",
    "wie spät ist es", "¿qué hora es?", "quelle heure est-il", "hoe laat is het", "hur mycket är klockan",
]


def sentences():
    yield from FIXED
    import site
    for sp in site.getsitepackages():
        for f in Path(sp).glob("*/locale/*/*.intent"):
            for line in f.read_text(errors="ignore").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    yield line


def main():
    texts = list(dict.fromkeys(sentences()))
    ok = True
    for path in sys.argv[1:]:
        r = real.Tokenizer.from_file(path)
        s = shim.Tokenizer.from_file(path)
        diff = []
        for t in texts:
            a = r.encode(t, add_special_tokens=False).ids
            b = s.encode(t, add_special_tokens=False).ids
            if a != b:
                diff.append((t, r.encode(t, add_special_tokens=False).tokens, s.encode(t, add_special_tokens=False).tokens))
        same_vocab = r.get_vocab() == s.get_vocab()
        print(f"{path}: {len(texts) - len(diff)}/{len(texts)} identical, vocab {'same' if same_vocab else 'DIFFERENT'}")
        for t, a, b in diff[:8]:
            print(f"   {t!r}\n     real {a}\n     shim {b}")
        ok &= not diff and same_vocab
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
