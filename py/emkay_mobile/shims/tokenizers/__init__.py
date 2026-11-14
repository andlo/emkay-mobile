"""Pure-Python stand-in for HuggingFace `tokenizers` (Rust, no WebAssembly build).

Only what model2vec needs to *run* a model: load a tokenizer.json and turn
text into token ids. Covers the two families OpenVoiceOS' m2v intent models
use:

  * WordPiece  + BertNormalizer + BertPreTokenizer   (ovos-m2v-intents-en)
  * Unigram    + Precompiled    + Metaspace          (ovos-m2v-intents-multilingual)

`tools/check_tokenizers_shim.py` compares it against the real package.
Training, decoding, offsets and pair inputs are not implemented.
"""
import json
import re
import unicodedata

__version__ = "0.0.0-emkay-shim"


# ---------------------------------------------------------------- normalizers

def _bert_clean(text):
    out = []
    for ch in text:
        cp = ord(ch)
        if cp == 0 or cp == 0xFFFD or (unicodedata.category(ch).startswith("C") and ch not in "\t\n\r"):
            continue
        out.append(" " if ch in "\t\n\r" or unicodedata.category(ch) == "Zs" else ch)
    return "".join(out)


def _is_cjk(cp):
    return (0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or 0x20000 <= cp <= 0x2A6DF
            or 0x2A700 <= cp <= 0x2B73F or 0x2B740 <= cp <= 0x2B81F or 0x2B820 <= cp <= 0x2CEAF
            or 0xF900 <= cp <= 0xFAFF or 0x2F800 <= cp <= 0x2FA1F)


def _strip_accents(text):
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")


_INVISIBLE = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff\u00ad\t\n\r\x0b\x0c"), " ")


def _nmt_nfkc(text):
    text = unicodedata.normalize("NFKC", text).translate(_INVISIBLE)
    return "".join(c for c in text if c == " " or unicodedata.category(c) != "Cc")


def _normalizer(spec):
    if spec is None:
        return lambda s: s
    t = spec["type"]
    if t == "Sequence":
        steps = [_normalizer(n) for n in spec["normalizers"]]

        def seq(s):
            for f in steps:
                s = f(s)
            return s
        return seq
    if t in ("NFC", "NFD", "NFKC", "NFKD"):
        return lambda s: unicodedata.normalize(t, s)
    if t == "Precompiled":
        # SentencePiece's compiled nmt_nfkc table: NFKC, plus zero-width and
        # other invisible format characters turned into spaces and control
        # characters dropped (checked against the real tokenizers)
        return _nmt_nfkc
    if t == "Lowercase":
        return str.lower
    if t == "StripAccents":
        return _strip_accents
    if t == "Strip":
        left, right = spec.get("strip_left", True), spec.get("strip_right", True)
        return lambda s: s.lstrip() if left and not right else s.rstrip() if right and not left else s.strip()
    if t == "Replace":
        pat = spec["pattern"]
        rx = re.compile(pat["Regex"]) if "Regex" in pat else re.compile(re.escape(pat["String"]))
        return lambda s: rx.sub(spec["content"], s)
    if t == "BertNormalizer":
        lower = spec.get("lowercase", True)
        strip = spec.get("strip_accents")
        strip = lower if strip is None else strip

        def bert(s):
            if spec.get("clean_text", True):
                s = _bert_clean(s)
            if spec.get("handle_chinese_chars", True):
                s = "".join(f" {c} " if _is_cjk(ord(c)) else c for c in s)
            if strip:
                s = _strip_accents(s)
            return s.lower() if lower else s
        return bert
    raise NotImplementedError(f"tokenizers shim: normalizer {t}")


# ------------------------------------------------------------ pre-tokenizers

def _is_punct(ch):
    cp = ord(ch)
    if 33 <= cp <= 47 or 58 <= cp <= 64 or 91 <= cp <= 96 or 123 <= cp <= 126:
        return True
    return unicodedata.category(ch).startswith("P")


def _bert_split(text):
    words, cur = [], []
    for ch in text:
        if ch.isspace():
            if cur:
                words.append("".join(cur))
                cur = []
        elif _is_punct(ch):
            if cur:
                words.append("".join(cur))
                cur = []
            words.append(ch)
        else:
            cur.append(ch)
    if cur:
        words.append("".join(cur))
    return words


def _pre_tokenizer(spec):
    if spec is None:
        return lambda words: words
    t = spec["type"]
    if t == "Sequence":
        steps = [_pre_tokenizer(p) for p in spec["pretokenizers"]]

        def seq(words):
            for f in steps:
                words = f(words)
            return words
        return seq
    if t == "BertPreTokenizer":
        return lambda words: [p for w in words for p in _bert_split(w)]
    if t == "WhitespaceSplit":
        return lambda words: [p for w in words for p in w.split()]
    if t == "Whitespace":
        rx = re.compile(r"\w+|[^\w\s]+")
        return lambda words: [p for w in words for p in rx.findall(w)]
    if t == "Metaspace":
        rep = spec.get("replacement", "▁")
        scheme = spec.get("prepend_scheme", "always" if spec.get("add_prefix_space", True) else "never")
        split = spec.get("split", True)

        def meta(words):
            out = []
            for i, w in enumerate(words):
                if not w:
                    continue
                w = w.replace(" ", rep)
                if scheme == "always" or (scheme == "first" and i == 0):
                    if not w.startswith(rep):
                        w = rep + w
                if split:
                    out += [p for p in re.split(f"(?={re.escape(rep)})", w) if p]
                else:
                    out.append(w)
            return out
        return meta
    raise NotImplementedError(f"tokenizers shim: pre_tokenizer {t}")


# --------------------------------------------------------------------- models

class WordPiece:
    def __init__(self, spec):
        self.vocab = spec["vocab"]
        self.unk_token = spec.get("unk_token", "[UNK]")
        self.prefix = spec.get("continuing_subword_prefix", "##")
        self.max_chars = spec.get("max_input_chars_per_word", 100)

    def tokenize(self, word):
        if len(word) > self.max_chars:
            return [self.unk_token]
        out, start = [], 0
        while start < len(word):
            end, piece = len(word), None
            while start < end:
                sub = word[start:end]
                if start > 0:
                    sub = self.prefix + sub
                if sub in self.vocab:
                    piece = sub
                    break
                end -= 1
            if piece is None:
                return [self.unk_token]
            out.append(piece)
            start = end
        return out


class Unigram:
    unk_token = None   # model2vec reads unk_id from to_str() for Unigram

    def __init__(self, spec):
        self.pieces = {p: (i, s) for i, (p, s) in enumerate(spec["vocab"])}
        self.unk_id = spec.get("unk_id")
        self.unk_piece = spec["vocab"][self.unk_id][0] if self.unk_id is not None else None
        scores = [s for _, s in spec["vocab"]]
        self.unk_score = (min(scores) if scores else 0.0) - 10.0
        self.max_len = max((len(p) for p in self.pieces), default=1)

    def tokenize(self, word):
        """Viterbi: the segmentation with the highest total piece score."""
        n = len(word)
        best = [(-1e18, -1, None)] * (n + 1)   # (score, start, piece or None=unk)
        best[0] = (0.0, -1, None)
        for end in range(1, n + 1):
            top = (-1e18, -1, None)
            for start in range(max(0, end - self.max_len), end):
                if best[start][0] <= -1e17:
                    continue
                piece = word[start:end]
                hit = self.pieces.get(piece)
                if hit is not None:
                    cand = best[start][0] + hit[1]
                    if cand > top[0]:
                        top = (cand, start, piece)
            if top[1] < 0 or top[0] <= -1e17:
                # no piece ends here: one unknown character
                prev = best[end - 1][0]
                top = (prev + self.unk_score, end - 1, None)
            best[end] = top
        out, end = [], n
        while end > 0:
            _, start, piece = best[end]
            out.append(piece if piece is not None else self.unk_piece)
            end = start
        out.reverse()
        # fuse consecutive unknowns, like the Rust implementation
        fused = []
        for p in out:
            if p == self.unk_piece and fused and fused[-1] == self.unk_piece:
                continue
            fused.append(p)
        return fused


class WordLevel:
    def __init__(self, spec):
        self.vocab = spec["vocab"]
        self.unk_token = spec.get("unk_token")

    def tokenize(self, word):
        return [word if word in self.vocab else self.unk_token]


_MODELS = {"WordPiece": WordPiece, "Unigram": Unigram, "WordLevel": WordLevel}


# ------------------------------------------------------------------ public API

class Encoding:
    def __init__(self, ids, tokens):
        self.ids = ids
        self.tokens = tokens
        self.attention_mask = [1] * len(ids)
        self.type_ids = [0] * len(ids)

    def __len__(self):
        return len(self.ids)

    def __repr__(self):
        return f"Encoding(num_tokens={len(self.ids)})"


class Tokenizer:
    def __init__(self, spec: dict):
        self._spec = spec
        m = spec["model"]
        self.model = _MODELS[m["type"]](m)
        if m["type"] == "Unigram":
            self._vocab = {p: i for p, (i, _) in self.model.pieces.items()}
        else:
            self._vocab = dict(m["vocab"])
        for tok in spec.get("added_tokens") or []:
            self._vocab.setdefault(tok["content"], tok["id"])
        self._ids = {i: t for t, i in self._vocab.items()}
        self._normalize = _normalizer(spec.get("normalizer"))
        self._pre = _pre_tokenizer(spec.get("pre_tokenizer"))
        self.padding = spec.get("padding")
        self.truncation = spec.get("truncation")
        self._special = self._special_template(spec.get("post_processor"))

    # construction
    @classmethod
    def from_str(cls, s):
        return cls(json.loads(s))

    @classmethod
    def from_file(cls, path):
        with open(path, encoding="utf-8") as f:
            return cls(json.load(f))

    def to_str(self, pretty=False):
        return json.dumps(self._spec, indent=2 if pretty else None, ensure_ascii=False)

    def save(self, path, pretty=True):
        with open(path, "w", encoding="utf-8") as f:
            f.write(self.to_str(pretty))

    # vocabulary
    def get_vocab(self, with_added_tokens=True):
        return dict(self._vocab)

    def get_vocab_size(self, with_added_tokens=True):
        return len(self._vocab)

    def token_to_id(self, token):
        return self._vocab.get(token)

    def id_to_token(self, i):
        return self._ids.get(i)

    # padding / truncation: model2vec only toggles these
    def enable_padding(self, **kw):
        self.padding = {"pad_id": kw.get("pad_id", 0), "pad_token": kw.get("pad_token", "[PAD]"),
                        "pad_type_id": kw.get("pad_type_id", 0), "length": kw.get("length")}

    def no_padding(self):
        self.padding = None

    def enable_truncation(self, max_length, **kw):
        self.truncation = {"max_length": max_length}

    def no_truncation(self):
        self.truncation = None

    # encoding
    def _special_template(self, post):
        if not post or post.get("type") != "TemplateProcessing":
            return ([], [])
        before, after, seen = [], [], False
        for item in post.get("single", []):
            if "Sequence" in item:
                seen = True
            elif "SpecialToken" in item:
                (after if seen else before).append(item["SpecialToken"]["id"])
        return (before, after)

    def encode(self, sequence, pair=None, is_pretokenized=False, add_special_tokens=True):
        if pair is not None:
            raise NotImplementedError("tokenizers shim: pair inputs")
        words = list(sequence) if is_pretokenized else [self._normalize(sequence)]
        words = self._pre(words)
        tokens = [p for w in words if w for p in self.model.tokenize(w)]
        if add_special_tokens:
            before, after = self._special
            tokens = before + tokens + after
        ids = [self._vocab[t] for t in tokens if t in self._vocab]
        if self.truncation and self.truncation.get("max_length"):
            ids = ids[: self.truncation["max_length"]]
        return Encoding(ids, [self._ids[i] for i in ids])

    def encode_batch(self, inputs, is_pretokenized=False, add_special_tokens=True):
        return [self.encode(s, is_pretokenized=is_pretokenized, add_special_tokens=add_special_tokens)
                for s in inputs]

    encode_batch_fast = encode_batch

    def decode(self, ids, skip_special_tokens=True):
        return " ".join(self._ids.get(i, "") for i in ids)
