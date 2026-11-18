"""Add language: a skill's en-US files translated in the browser (emkay-voice/vscode-emkay#2).

What is translated, and how, is OVOS' own: ovos-localize's
translate_linguonnx.py (vendored as ovl_translate.py) masks every {slot},
sends each alternative of an (a|b) group and each [optional] part on its own,
and drops a line that does not come back intact – and ovos-localize's
validators check the result. The model is the one ovos-localize's linguonnx
uses for English → that language (an OPUS-MT Marian model in ONNX), run by
web/mt.js in this worker; SentencePiece (Pyodide's package) turns text into
the model's tokens and back. Nothing leaves the device but the one-time
download of the model and of ovos-localize.

ovl_translate.translate_lines calls its translate function once per piece,
synchronously, and the pieces it asks for depend only on the source line.
So it runs twice: once to collect the pieces, which are then translated with
the model (asynchronously, here), and once more with the answers.
"""
import json
import os

from . import ovl_translate as ovl

#: what ovos-localize translates; .list files (our templates' data, one item
#: per line, cells split by " | ") are translated cell by cell; the rest
#: (regular expressions, settings) is copied unchanged and reported
TRANSLATED = ovl.SUFFIXES
SKILL_JSON_FIELDS = ("name", "description")

_tok = {}   # model id -> (src spm, tgt spm, vocab, inverse vocab, specials, target token id)


async def _tokenizer(lang):
    import js
    import pyodide_js
    side = (await js.emkayMT.side(lang)).to_py()
    mid = side["id"]
    if mid not in _tok:
        await pyodide_js.loadPackage("sentencepiece")
        import sentencepiece as spm
        d = f"/tmp/mt/{mid}"
        os.makedirs(d, exist_ok=True)
        for name in ("source_spm", "target_spm"):
            with open(f"{d}/{name}", "wb") as f:
                f.write(bytes(side[name]))
        vocab = json.loads(side["vocab"])
        cfg = json.loads(side["config"])
        inv = {i: p for p, i in vocab.items()}
        specials = {cfg.get("pad_token_id"), cfg.get("eos_token_id"), vocab.get("<unk>")}
        target = vocab.get(side["target"]) if side["target"] else None
        _tok[mid] = (spm.SentencePieceProcessor(model_file=f"{d}/source_spm"),
                     spm.SentencePieceProcessor(model_file=f"{d}/target_spm"),
                     vocab, inv, specials, target, cfg, side)
    return _tok[mid]


async def _model_translate(lang, texts):
    """{text: translation} for each piece, with the model."""
    import js
    from pyodide.ffi import to_js
    src, tgt, vocab, inv, specials, target, cfg, _ = await _tokenizer(lang)
    unk = vocab.get("<unk>", 1)
    out = {}
    for text in texts:
        ids = [vocab.get(p, unk) for p in src.encode(text, out_type=str)] + [cfg["eos_token_id"]]
        if target is not None:
            ids = [target] + ids
        got = (await js.emkayMT.generate(lang, to_js(ids))).to_py()
        pieces = [inv[i] for i in got if i in inv and i not in specials]
        out[text] = tgt.decode_pieces(pieces).strip()
    return out


#: ovos-localize drops a line the model gave back unchanged; for a cell of a
#: .list or a skill.json field that is often right (a number, a name)
SAME = "output identical to input"


async def _items(lang, items, tgt):
    """Items translated one by one; an item that does not come back keeps its
    English text (a number, a name). (translated, dropped [(item, reason)])."""
    got, drop = [], []
    for item in items:
        t, d = await _lines(lang, [item], tgt=tgt)
        if t:
            got.append(t[0])
        else:
            got.append(item)
            if d and d[0][1] != SAME:
                drop.append(d[0])
    return got, drop


async def _lines(lang, lines, src="en", tgt=None):
    """ovos-localize's translate_lines over the model: (translated lines, dropped [(line, reason)])."""
    tgt = tgt or lang
    asked = []

    def collect(text, s, t):
        asked.append(text)
        return text                    # the source itself: same structure, same pieces asked

    for line in lines:
        ovl._translate_line(collect, line, src, tgt)
    answers = await _model_translate(lang, list(dict.fromkeys(asked)))
    out, dropped = [], []
    for line in lines:
        t, reason = ovl._translate_line(lambda text, s, t_: answers.get(text, ""), line, src, tgt)
        if t is not None:
            out.append(t)
        elif reason:
            dropped.append((line, reason))
    return out, dropped


async def _validator():
    """ovos-localize's validators (pure Python), installed the first time."""
    try:
        from ovos_localize.validators.rules import validate_file
    except ImportError:
        import micropip
        await micropip.install("ovos-localize", deps=False)
        from ovos_localize.validators.rules import validate_file
    from ovos_localize.parsers import get_parser
    return validate_file, get_parser


async def translate_files(lang: str, files_json: str) -> str:
    """Translate a skill's en-US locale files ({relative path: text}) into `lang`.

    Returns JSON: {ok, files: {path: text}, dropped: [{file, line, reason}],
    copied: [path], problems: [{file, severity, rule, message}], model, repo}.
    """
    files = json.loads(files_json)
    short = lang.split("-")[0].lower()
    out, dropped, copied, problems = {}, [], [], []
    for path, text in sorted(files.items()):
        name = path.rsplit("/", 1)[-1]
        lines = text.splitlines()
        if name == "skill.json":
            try:
                data = json.loads(text)
            except ValueError:
                copied.append(path)
                out[path] = text
                continue
            fields = [k for k in SKILL_JSON_FIELDS if isinstance(data.get(k), str)]
            examples = [e for e in data.get("examples", []) if isinstance(e, str)]
            got, drop = await _items(lang, [data[k] for k in fields] + examples, short)
            for k, v in zip(fields, got):
                data[k] = v
            if examples:
                data["examples"] = got[len(fields):]
            dropped += [{"file": path, "line": l, "reason": r} for l, r in drop]
            out[path] = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        elif name.endswith(TRANSLATED):
            got, drop = await _lines(lang, lines, tgt=short)
            dropped += [{"file": path, "line": l, "reason": r} for l, r in drop]
            if any(l.strip() for l in got):
                out[path] = "\n".join(got) + "\n"
        elif name.endswith(".list"):
            rows = [[c.strip() for c in l.split("|")] for l in lines if l.strip()]
            cells = [c for r in rows for c in r if c]
            got, drop = await _items(lang, cells, short)
            dropped += [{"file": path, "line": l, "reason": r} for l, r in drop]
            it = iter(got)
            out[path] = "\n".join(" | ".join(next(it) if c else c for c in r) for r in rows) + "\n"
        else:
            copied.append(path)
            out[path] = text
    # ovos-localize's own checks, each translated file against its source
    try:
        validate_file, get_parser = await _validator()
        for path, text in out.items():
            parser = get_parser(path)
            if not parser or path in copied:
                continue
            p = parser()
            for issue in validate_file(p.parse_content(text, path), p.parse_content(files[path], path)):
                problems.append({"file": path, "severity": issue.severity, "rule": issue.rule_name,
                                 "message": issue.message})
    except Exception as e:   # the checks are a help; a translation without them is still one
        problems.append({"file": "", "severity": "info", "rule": "validators", "message": f"not checked: {e}"})
    side = (await _tokenizer(lang))[7] if out else {}
    return json.dumps({"ok": True, "files": out, "dropped": dropped, "copied": copied, "problems": problems,
                       "model": side.get("id", ""), "repo": side.get("repo", "")}, ensure_ascii=False)
