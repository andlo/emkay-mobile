class Levenshtein:
    @staticmethod
    def distance(a, b, **kw):
        a, b = str(a), str(b)
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i]
            for j, cb in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
            prev = cur
        return prev[-1]

    @classmethod
    def normalized_similarity(cls, a, b, **kw):
        n = max(len(a), len(b)) or 1
        return 1 - cls.distance(a, b) / n
