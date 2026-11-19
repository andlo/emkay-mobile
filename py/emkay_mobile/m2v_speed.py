"""ovos-m2v-pipeline's word_sequence: the same text, made in C (issue #4).

Every template sample a skill registers is put in word form (lowercase, each
Unicode punctuation or symbol character a word break) before m2v embeds it
as a prototype: `slots.word_sequence`, also used on every utterance. It goes
through the text one character at a time in a Python generator, asking
`unicodedata.category` for each. For Emkay's skills that was 291,000 calls
and 11.6 million characters at every start: about a quarter of the boot in
WebAssembly.

This gives `str.translate` a table that knows each character's answer: a
punctuation or symbol character becomes a space, anything else stays. A
character is looked up in unicodedata the first time it is seen, and after
that only in C. The result is exactly the original's. Meant for
ovos-m2v-pipeline itself.
"""
import unicodedata


class _Breaks(dict):
    """ord -> " " for punctuation and symbols (category P*, S*), else itself."""

    def __missing__(self, code):
        out = " " if unicodedata.category(chr(code))[0] in "PS" else code
        self[code] = out
        return out


_BREAKS = _Breaks()


def word_sequence(text: str) -> str:
    """slots.word_sequence: lowercase word tokens joined by single spaces."""
    return " ".join(text.lower().translate(_BREAKS).split())


def install():
    """Put word_sequence into ovos-m2v-pipeline, where it looks it up when
    called (slots.drop_free_slots and the pipeline's own `_word_sequence`).
    Safe to call more than once; nothing happens without the pipeline."""
    try:
        import ovos_m2v_pipeline
        from ovos_m2v_pipeline import slots
    except ImportError:
        return
    word_sequence.__wrapped__ = getattr(slots.word_sequence, "__wrapped__", slots.word_sequence)
    slots.word_sequence = word_sequence
    if hasattr(ovos_m2v_pipeline, "_word_sequence"):
        ovos_m2v_pipeline._word_sequence = word_sequence
