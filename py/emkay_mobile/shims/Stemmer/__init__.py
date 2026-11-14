"""Stand-in for PyStemmer: identity stemmer (padatious still matches, a bit less forgiving)."""
def algorithms():
    return ["english", "danish", "german", "spanish", "french", "portuguese", "italian", "dutch", "swedish", "norwegian"]


class Stemmer:
    def __init__(self, algorithm="english", maxCacheSize=0):
        self.algorithm = algorithm

    def stemWord(self, word):
        return word

    def stemWords(self, words):
        return list(words)
