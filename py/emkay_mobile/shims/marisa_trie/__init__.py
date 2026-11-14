"""Minimal stand-in for marisa-trie, enough for language_data's name lookups."""
class Trie:
    def __init__(self, keys=()):
        self._keys = sorted(set(keys))

    def __contains__(self, k):
        return k in self._keys

    def keys(self, prefix=""):
        return [k for k in self._keys if k.startswith(prefix)]

    def prefixes(self, s):
        return [k for k in self._keys if s.startswith(k)]

    def load(self, path):
        return self

    def __len__(self):
        return len(self._keys)


class BytesTrie(Trie):
    def __init__(self, items=()):
        self._d = {}
        for k, v in items:
            self._d.setdefault(k, []).append(v)
        super().__init__(self._d.keys())

    def __getitem__(self, k):
        return self._d[k]

    def get(self, k, default=None):
        return self._d.get(k, default)


RecordTrie = BytesTrie
