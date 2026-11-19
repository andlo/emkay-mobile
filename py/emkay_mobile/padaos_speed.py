"""padaos' line patterns: built faster, and the same at every start (issue #4).

ovos-padatious' padaos turns each template line into a regex by putting each
entity's pattern in for its {slot}. Two things made that slow in Emkay:

- `_create_intent_pattern` does it for every entity of the container, for
  every line: it formats each entity's whole pattern (twice) and tries to
  replace its slot, also when the line has no such slot. For Emkay's skills
  that is 22 entities x 22,347 lines: 899,411 str.format and 779,312
  str.replace calls in each compile.
- The capture groups are numbered in the order of a set() of slot names and
  of the entities dict - an order that changes from one process to the next
  (string hashing is randomised; skills register in their own order). So
  the same line gave a different pattern at every start, and no cache of
  compiled regexes (re_cache.py) could ever hit: 964 hits, 14,393 misses.

This builds the same replacements (the same overrides, the same wildcard
for a slot no entity fills), but only for the slots in the line, numbered in
sorted order. The numbers only keep group names apart within one intent's
regexes - padaos drops them when it reads a match (`rsplit('__', 1)`) - so
the patterns match exactly what they matched before. Meant for
ovos-padatious itself.
"""
import re

_SLOTS = re.compile(r'{([a-z_:]+)}')


def create_intent_pattern(self, line, intent_name, entities, counter):
    """padaos.IntentContainer._create_intent_pattern: same matches, faster, stable."""
    namespace = intent_name.split(':')[0] + ':'
    line = self._cap_line_alternations(line)
    line = self._patterns.get(line, self._create_pattern)
    # key -> (template, its arguments), with the original's overrides: a
    # wildcard for each slot in the line, then every entity (a later entity
    # filling the same slot wins, as in the original's dict)
    replacements = {}
    for ent_name in _SLOTS.findall(line):
        replacements[ent_name] = (r'(?P<{}__{{}}>.*?\w.*?)', (ent_name,))
    ent_regex = r'(?P<{}__{{}}>{})'
    for ent_name, ent in entities.items():
        if ent_name.startswith(namespace):
            short = ent_name[len(namespace):]
            if '{' + short + '}' in line:
                replacements[short] = (ent_regex, (short, ent))
        elif '{' + ent_name + '}' in line:
            replacements[ent_name] = (ent_regex, (ent_name.replace(':', '__colon__'), ent))
    for key in sorted(replacements):
        slot = '{' + key + '}'
        if slot in line:   # str.replace(..., 1): the first {slot} only, as the original
            template, args = replacements[key]
            line = line.replace(slot, template.format(*args).format(next(counter)), 1)
    return '^{}$'.format(line)


def create_regexes(self, lines, intent_name, entities, counter):
    """padaos.IntentContainer.create_regexes, its lines in a fixed order.

    The original orders an intent's lines longest first, and those of equal
    length as they came - and they come from the skill's samples, expanded
    from its (a|b) groups in an order that is not the same from one start to
    the next. The group numbers count through the lines, so that too made
    the patterns differ at every start. Longest first, then alphabetically,
    is the same at every start; between lines of the same length the order
    was arbitrary before as well.
    """
    from ovos_padatious.padaos import _PLAIN_LINE
    from . import padaos_lines
    k = padaos_lines.key(self, intent_name, lines, entities)
    kept = padaos_lines.get(k)
    if kept is not None:
        return kept
    regexes = [self._create_regex(line, intent_name, entities, counter)
               for line in sorted(lines, key=lambda l: (-len(l), l))
               if line.strip() and not _PLAIN_LINE.match(line)]
    regexes = [r for r in regexes if r is not None]
    padaos_lines.put(k, regexes)
    return regexes


def _fixed_order(lines):
    """Longest first, then alphabetically: the same order at every start."""
    return sorted(lines, key=lambda l: (-len(l), l))


def sorted_lines(add):
    """padaos.IntentContainer.add_entity / add_intent, the lines in a fixed order.

    An entity's values reach padaos in the order the skill's registration
    message has them, which is not the same from one start to the next
    ("groceries|todo|to do|shopping", then "groceries|shopping|todo|to do"),
    and padaos puts them into every pattern of every line that uses the
    entity in that order. The patterns are anchored (^...$), so the order of
    the alternatives doesn't change what matches - and it was arbitrary
    before as well.
    """
    def wrapped(self, name, lines):
        return add(self, name, _fixed_order(lines))
    wrapped.__wrapped__ = add
    return wrapped


def merged_save(self):
    """padaos._PatternCache.save, keeping what other containers wrote to the file.

    padaos keeps each template line's regex source in intent_cache/<lang>/
    padaos-patterns.json, so a restart need not rewrite the lines. But
    padatious' own pipeline, OCP's and the persona pipeline each make a
    padaos container on that same folder, and each saved only its own lines:
    whichever saved last threw the others' away (121 intents' 22,477 lines
    replaced by the 2 of OCP's "start {query}" container), so every other
    start rewrote them all. This keeps the file's lines and adds this
    container's. A line no container uses any more stays until padaos'
    rules change (PATTERN_RULES_VERSION): template lines are small.
    """
    import json
    import os
    import uuid
    from threading import get_ident
    from ovos_padatious import padaos
    if not (self.path and self._dirty and self._patterns is not None):
        return
    merged = {}
    try:
        with open(self.path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("rules") == padaos.PATTERN_RULES_VERSION:
            merged.update({str(k): str(v) for k, v in data["patterns"].items()})
    except (OSError, ValueError, KeyError, AttributeError, TypeError):
        pass
    merged.update({line: self._patterns[line] for line in self._used if line in self._patterns})
    tmp = f"{self.path}.{os.getpid()}.{get_ident()}.{uuid.uuid4().hex[:8]}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"rules": padaos.PATTERN_RULES_VERSION, "patterns": merged}, f)
        os.replace(tmp, self.path)
        self._dirty = False
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def install():
    """Put these into padaos, with its regexes from re_cache.py. Safe to call
    more than once. The browser does it (browser.adapt_ovos), and so does
    tools/build_intent_cache.py, so the patterns it leaves for the site's
    regex cache (re_cache.py, tools/re_seed.mjs) are the browser's."""
    from ovos_padatious import padaos
    from . import re_cache
    if getattr(padaos.IntentContainer._compile, "_emkay_re_cache", False):
        return
    from . import padaos_lines
    compile_fn = re_cache.around(padaos.IntentContainer._compile)

    def compiled(*args, **kwargs):
        try:
            return compile_fn(*args, **kwargs)
        finally:
            padaos_lines.save()
    compiled.__wrapped__ = compile_fn
    padaos.IntentContainer._compile = compiled
    padaos.IntentContainer._compile._emkay_re_cache = True
    padaos.IntentContainer._create_intent_pattern = create_intent_pattern
    padaos.IntentContainer.create_regexes = create_regexes
    padaos.IntentContainer.add_entity = sorted_lines(padaos.IntentContainer.add_entity)
    padaos.IntentContainer.add_intent = sorted_lines(padaos.IntentContainer.add_intent)
    padaos._PatternCache.save = merged_save
