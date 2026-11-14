from .fuzz import WRatio


def _items(choices):
    if hasattr(choices, "items"):
        return list(choices.items())
    return list(enumerate(choices))


def extract(query, choices, *, scorer=WRatio, processor=None, limit=5,
            score_cutoff=None, **kw):
    out = []
    for key, choice in _items(choices):
        q, c = (processor(query), processor(choice)) if processor else (query, choice)
        s = scorer(q, c)
        if score_cutoff is None or s >= score_cutoff:
            out.append((choice, s, key))
    out.sort(key=lambda x: -x[1])
    return out if limit is None else out[:limit]


def extractOne(query, choices, **kw):
    kw["limit"] = 1
    r = extract(query, choices, **kw)
    return r[0] if r else None


def extract_iter(query, choices, **kw):
    kw["limit"] = None
    yield from extract(query, choices, **kw)


def cdist(queries, choices, *, scorer=WRatio, **kw):
    return [[scorer(q, c) for c in choices] for q in queries]
