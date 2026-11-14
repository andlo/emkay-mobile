"""Pure-Python stand-in for pyahocorasick's Automaton (naive scan, fine for small vocabularies)."""
STORE_ANY = 2
KEY_STRING = 0


class Automaton:
    def __init__(self, *a, **k):
        self._d = {}

    def add_word(self, key, value=None):
        self._d[key] = key if value is None else value
        return True

    def make_automaton(self):
        pass

    def exists(self, key):
        return key in self._d

    def get(self, key, *default):
        if key in self._d:
            return self._d[key]
        if default:
            return default[0]
        raise KeyError(key)

    def __contains__(self, key):
        return key in self._d

    def __len__(self):
        return len(self._d)

    def keys(self, *a):
        return iter(self._d.keys())

    def values(self, *a):
        return iter(self._d.values())

    def items(self, *a):
        return iter(self._d.items())

    def iter(self, text, *a, **k):
        hits = []
        for key, val in self._d.items():
            start = text.find(key)
            while start != -1:
                hits.append((start + len(key) - 1, val))
                start = text.find(key, start + 1)
        hits.sort(key=lambda h: h[0])
        return iter(hits)

    def iter_long(self, text):
        return self.iter(text)
