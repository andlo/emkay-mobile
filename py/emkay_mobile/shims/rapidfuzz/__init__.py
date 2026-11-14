"""Pure-Python stand-in for rapidfuzz (no WebAssembly wheel exists yet).

Covers the parts OVOS uses: fuzz.*, process.extract/extractOne and
utils.default_process. Scores are 0-100 like rapidfuzz, built on difflib.
"""
from . import fuzz, process, utils, distance  # noqa: F401
__version__ = "3.0.0-emkay-shim"
