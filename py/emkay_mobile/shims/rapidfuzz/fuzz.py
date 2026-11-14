from difflib import SequenceMatcher


def _prep(a, b, processor):
    if processor:
        a, b = processor(a), processor(b)
    return str(a), str(b)


def ratio(s1, s2, *, processor=None, score_cutoff=None, **kw):
    s1, s2 = _prep(s1, s2, processor)
    if not s1 and not s2:
        return 100.0
    r = 100.0 * SequenceMatcher(None, s1, s2).ratio()
    return r if score_cutoff is None or r >= score_cutoff else 0.0


def partial_ratio(s1, s2, *, processor=None, score_cutoff=None, **kw):
    s1, s2 = _prep(s1, s2, processor)
    short, long_ = (s1, s2) if len(s1) <= len(s2) else (s2, s1)
    if not short:
        return 0.0
    best = 0.0
    for i in range(len(long_) - len(short) + 1):
        best = max(best, ratio(short, long_[i:i + len(short)]))
        if best == 100.0:
            break
    return best if score_cutoff is None or best >= score_cutoff else 0.0


def _sorted(s):
    return " ".join(sorted(s.split()))


def token_sort_ratio(s1, s2, *, processor=None, score_cutoff=None, **kw):
    s1, s2 = _prep(s1, s2, processor)
    return ratio(_sorted(s1), _sorted(s2), score_cutoff=score_cutoff)


def token_set_ratio(s1, s2, *, processor=None, score_cutoff=None, **kw):
    s1, s2 = _prep(s1, s2, processor)
    a, b = set(s1.split()), set(s2.split())
    inter = " ".join(sorted(a & b))
    da, db = " ".join(sorted(a - b)), " ".join(sorted(b - a))
    c1, c2 = (inter + " " + da).strip(), (inter + " " + db).strip()
    r = max(ratio(inter, c1), ratio(inter, c2), ratio(c1, c2)) if inter else ratio(c1, c2)
    return r if score_cutoff is None or r >= score_cutoff else 0.0


def partial_token_sort_ratio(s1, s2, **kw):
    s1, s2 = _prep(s1, s2, kw.pop("processor", None))
    return partial_ratio(_sorted(s1), _sorted(s2), **kw)


def partial_token_set_ratio(s1, s2, **kw):
    return token_set_ratio(s1, s2, **kw)


def token_ratio(s1, s2, **kw):
    return max(token_sort_ratio(s1, s2, **kw), token_set_ratio(s1, s2, **kw))


def partial_token_ratio(s1, s2, **kw):
    return max(partial_token_sort_ratio(s1, s2, **kw), partial_token_set_ratio(s1, s2, **kw))


def WRatio(s1, s2, **kw):
    return max(ratio(s1, s2, **kw), 0.95 * token_ratio(s1, s2, **kw),
               0.9 * partial_ratio(s1, s2, **kw))


def QRatio(s1, s2, **kw):
    return ratio(s1, s2, **kw)
