import re
_NON = re.compile(r"[^\w\s]", re.UNICODE)
def default_process(s):
    return _NON.sub(" ", str(s)).lower().strip()
