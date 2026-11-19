"""chronologia reads the one language it loads, not all 61 (issue #4).

ovos-core's typed-slots stage finds dates and times in what was said with
chronologia, and the first sentence after a start makes it load its
language: `load_lang_spec` builds an `ovos_spec_tools.LocaleResources` over
chronologia's locale tree only to ask it for `vocabularies(lang)`. But
LocaleResources reads every language of the tree it is given when it is
made - 61 languages, 6,861 files, two or three times - and in WebAssembly
that was most of the six seconds in front of the first answer.

This stands in for LocaleResources in chronologia's loader with the same
`vocabularies()` for one language (sorted paths, a later file of the same
name winning), read from that language's folder only. Proposed upstream in
TigreGotico/chronologia, which then needs no LocaleResources here at all.
"""
import os
from pathlib import Path


class OneLanguage:
    """LocaleResources(locale_dir), as far as chronologia's loader uses it."""

    def __init__(self, locale_dir, *args, **kwargs):
        self.locale_dir = locale_dir

    def vocabularies(self, lang):
        from ovos_spec_tools import read_resource_file
        vocs = {}
        for path in sorted(Path(os.path.join(self.locale_dir, lang)).rglob("*.voc")):
            if path.is_file():
                vocs[path.stem] = list(read_resource_file(path))
        return vocs


def install():
    """Put OneLanguage in chronologia's loader, if it still uses LocaleResources."""
    try:
        from chronologia.extract import loader
    except ImportError:
        return False
    if getattr(loader, "LocaleResources", None) is None or loader.LocaleResources is OneLanguage:
        return False
    loader.LocaleResources = OneLanguage
    return True
