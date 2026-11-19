"""ovos-spec-tools' template expansion, each template once (issue #4).

Every pipeline that takes a skill's intents (padatious, m2v, the keyword
template matcher, ...) expands each template line to its samples with
`ovos_spec_tools.expansion`, and checks it again on the way (balance,
names, bare pipes, folding). For Emkay's skills that was about 100,000
expansions at every start, of which nine in ten were a template that had
already been expanded: a sixth of the boot in WebAssembly.

The expansion of a template depends only on the template and the direction
(when no vocabularies are given, as here), so the answer is kept and given
again: the same samples in the same order, or the same MalformedTemplate at
the same place. A caller that stops early (islice over a huge template) is
not remembered, and nothing past a budget of samples is kept, so memory
stays bounded. Meant for ovos-spec-tools itself.
"""
#: at most this many samples are kept in all (a few MB), and none of a
#: template with more than PER_TEMPLATE
BUDGET = 150_000
PER_TEMPLATE = 2_000

_memo = {}     # (template, direction) -> (samples tuple, exception or None)
_kept = 0
_orig_iter = _orig_expand = None


def _key(template, vocabularies, stack, direction):
    if vocabularies or stack or not isinstance(template, str) or not isinstance(direction, str):
        return None
    return template, direction


def _again(exc):
    """A new exception like `exc`, so each caller gets its own traceback."""
    try:
        return type(exc)(*exc.args)
    except Exception:  # noqa: BLE001 - an exception that can't be made again
        return exc


def _iter_expand(template, vocabularies, stack, *, direction=None):
    from ovos_spec_tools import expansion as ex
    direction = ex.INPUT_DIRECTION if direction is None else direction
    key = _key(template, vocabularies, stack, direction)
    if key is None:
        yield from _orig_iter(template, vocabularies, stack, direction=direction)
        return
    hit = _memo.get(key)
    if hit is not None:
        samples, exc = hit
        yield from samples
        if exc is not None:
            raise _again(exc)
        return
    got, keep = [], True
    try:
        for sample in _orig_iter(template, vocabularies, stack, direction=direction):
            if keep:
                got.append(sample)
                keep = len(got) <= PER_TEMPLATE
            yield sample
    except ex.MalformedTemplate as e:
        if keep:
            _remember(key, got, e)
        raise
    if keep:
        _remember(key, got, None)


def _remember(key, samples, exc):
    global _kept
    if _kept + len(samples) > BUDGET:
        return
    # a copy of the exception: the one being raised holds the frames of its traceback
    _memo[key] = (tuple(samples), None if exc is None else _again(exc))
    _kept += len(samples)


def _expand(template, vocabularies, stack, *, direction=None):
    """expansion._expand: its own checks, then list(_iter_expand(...)) –
    which is the memo above, so the checks are all that is left to skip."""
    from ovos_spec_tools import expansion as ex
    direction = ex.INPUT_DIRECTION if direction is None else direction
    key = _key(template, vocabularies, stack, direction)
    hit = _memo.get(key) if key is not None else None
    if hit is None:
        return _orig_expand(template, vocabularies, stack, direction=direction)
    samples, exc = hit
    if exc is not None:
        raise _again(exc)
    return list(samples)


def install():
    """Put the memo into ovos_spec_tools.expansion, whose expand() and
    iter_expand() look up _expand and _iter_expand when called. Safe to call
    more than once; nothing happens without ovos-spec-tools."""
    global _orig_iter, _orig_expand
    try:
        from ovos_spec_tools import expansion as ex
    except ImportError:
        return
    if getattr(ex._iter_expand, "_emkay_memo", False):
        return
    _orig_iter, _orig_expand = ex._iter_expand, ex._expand
    _iter_expand._emkay_memo = True
    ex._iter_expand = _iter_expand
    ex._expand = _expand
