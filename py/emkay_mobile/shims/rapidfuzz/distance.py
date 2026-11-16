"""rapidfuzz.distance: Levenshtein, DamerauLevenshtein and OSA in pure Python.

Each has rapidfuzz's four methods: distance, similarity (max length minus
distance), normalized_distance and normalized_similarity (0..1). Inputs
are compared as strings. Slower than rapidfuzz, which is fine for the short
names skills compare (stations, titles).
"""


class _Metric:
    @classmethod
    def distance(cls, a, b, **kw):
        raise NotImplementedError

    @classmethod
    def similarity(cls, a, b, **kw):
        a, b = str(a), str(b)
        return max(len(a), len(b)) - cls.distance(a, b)

    @classmethod
    def normalized_distance(cls, a, b, **kw):
        a, b = str(a), str(b)
        n = max(len(a), len(b))
        return cls.distance(a, b) / n if n else 0.0

    @classmethod
    def normalized_similarity(cls, a, b, **kw):
        return 1 - cls.normalized_distance(a, b)


class Levenshtein(_Metric):
    """Insertions, deletions and substitutions."""

    @classmethod
    def distance(cls, a, b, **kw):
        a, b = str(a), str(b)
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i]
            for j, cb in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
            prev = cur
        return prev[-1]


class OSA(_Metric):
    """Optimal string alignment: Levenshtein plus swapping two neighbours,
    each substring edited at most once."""

    @classmethod
    def distance(cls, a, b, **kw):
        a, b = str(a), str(b)
        d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
        for i in range(len(a) + 1):
            d[i][0] = i
        for j in range(len(b) + 1):
            d[0][j] = j
        for i in range(1, len(a) + 1):
            for j in range(1, len(b) + 1):
                cost = a[i - 1] != b[j - 1]
                d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
                if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                    d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
        return d[len(a)][len(b)]


class DamerauLevenshtein(_Metric):
    """Levenshtein plus swapping two neighbours, without OSA's limit
    (Lowrance-Wagner), as rapidfuzz.distance.DamerauLevenshtein."""

    @classmethod
    def distance(cls, a, b, **kw):
        a, b = str(a), str(b)
        big = len(a) + len(b)
        last_row = {}
        d = [[big] * (len(b) + 2) for _ in range(len(a) + 2)]
        for i in range(len(a) + 1):
            d[i + 1][0], d[i + 1][1] = big, i
        for j in range(len(b) + 1):
            d[0][j + 1], d[1][j + 1] = big, j
        for i in range(1, len(a) + 1):
            last_match_col = 0
            for j in range(1, len(b) + 1):
                k = last_row.get(b[j - 1], 0)
                l_ = last_match_col
                cost = 1
                if a[i - 1] == b[j - 1]:
                    cost, last_match_col = 0, j
                d[i + 1][j + 1] = min(
                    d[i][j] + cost,             # substitution
                    d[i + 1][j] + 1,            # insertion
                    d[i][j + 1] + 1,            # deletion
                    d[k][l_] + (i - k - 1) + 1 + (j - l_ - 1))   # transposition
            last_row[a[i - 1]] = i
        return d[len(a) + 1][len(b) + 1]
