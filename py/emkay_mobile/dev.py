"""Emkay Dev: run a skill from its files while you write it (dev.emkay.ai).

With `?dev` Emkay takes a skill from the window it sits in - the "Emkay
Dev" extension in VS Code (vscode.dev, github.dev, Codespaces or the
desktop app) - as files, not as a package: what you see in the editor is
what runs, a moment after you save, without building or publishing
anything. The page side is web/dev.js; this is the Python side.

A skill loads the way ovos-core loads one from a folder: ovos-workshop's
SkillLoader with the folder and the skill id, on the same bus as every other
skill, so intents, dialogs, settings and the GUI behave as on a device. It
is kept apart from SkillManager's plugin skills on purpose: SkillManager
unloads plugin skills it cannot find as installed packages, and a skill in
the making is not one. A store-installed copy of the same skill is unloaded
while the dev copy runs, so the two do not answer the same questions.

The skill's own requirements are installed with Emkay's pip (pip.py), the
same way the store installs a skill's - so a requirement Emkay cannot run
(a native package without a WebAssembly build) says so here, early.

Logs: while dev mode is on, OVOS' warnings and errors, its INFO lines about
loading skills and matching intents (_TOLD), and every line from the skill
being developed (DEBUG too) go to the page as "devlog" and on to the
extension's output panel.
"""
import json
import logging
import os
import re
import shutil
import time

#: Where the skills being developed are written (kept in IndexedDB like
#: the rest of ~/.local, so a reload can load them again before VS Code
#: sends them).
DEV_ROOT = os.path.expanduser("~/.local/share/emkay-dev/skills")

#: An OVOS skill id: "ovos-skill-hello.yourname" and the like.
SKILL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

#: Requirements Emkay already has in some form; installing them again from
#: PyPI only costs time (and pulls in pins meant for a device).
ALREADY_THERE = ("ovos-workshop", "ovos-utils", "ovos-bus-client", "ovos-core",
                 "ovos-plugin-manager", "ovos-config", "ovos-date-parser",
                 "ovos-number-parser", "ovos-lang-parser", "ovos-yes-no-solver")

_post = None          # set by enable(): post(kind, payload)
_loaders = {}         # skill_id -> SkillLoader of the dev copy
_replaced = {}        # skill_id -> True when a store-installed copy was unloaded for it
_watching = set()     # module names whose DEBUG lines are shown (the dev skills)


def enable(post):
    """Dev mode on: logs go to the page (`post("devlog", json)`)."""
    global _post
    first = _post is None
    _post = post
    if first:
        _hook_logging()
    return json.dumps({"ok": True, "root": DEV_ROOT})


# --------------------------------------------------------------- logging

def _hook_logging():
    """Copy log records to the page.

    ovos-utils' LOG makes one logger per call site ("OVOS - module:func:line"),
    each with its own stdout handler and propagate off, so a handler on the
    root logger never sees them. Hooking Logger.callHandlers sees them all.
    """
    original = logging.Logger.callHandlers

    def call_handlers(self, record):
        original(self, record)
        try:
            _forward(record)
        except Exception:
            pass

    logging.Logger.callHandlers = call_handlers


#: Where the INFO lines worth a skill developer's time come from (loading
#: skills, matching intents); everything else shows from WARNING up, and the
#: skill being developed shows everything (DEBUG too).
_TOLD = ("skill_launcher", "skill_manager", "intent_services", "ovos_workshop.skills",
         "ovos_padatious", "emkay_mobile.dev", "emkay_mobile.pip")

#: ERROR lines while a skill loads (load() names the first one as the problem)
_capture = None


def _forward(record):
    if _capture is not None and record.levelno >= logging.ERROR:
        _capture.append(record.getMessage().splitlines()[0])
    if _post is None:
        return
    name = record.name or ""
    mine = any(m in name or record.module == m for m in _watching)
    if not mine and record.levelno < (logging.INFO if any(n in name for n in _TOLD) else logging.WARNING):
        return
    text = record.getMessage()
    if record.exc_info:
        import traceback
        text += "\n" + "".join(traceback.format_exception(*record.exc_info)).rstrip()
    _post("devlog", json.dumps({
        "t": round(record.created, 3), "level": record.levelname,
        "name": name.replace("OVOS - ", ""), "msg": text, "mine": mine}))


# --------------------------------------------------------------- loading

def _safe_path(rel: str) -> str:
    """A file's path inside the skill folder; refuses ../, absolute paths and the like."""
    rel = rel.replace("\\", "/").lstrip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        raise ValueError(f"not a path inside the skill: {rel!r}")
    return os.path.join(*parts)


def _requirement_name(req: str) -> str:
    return re.split(r"[\s<>=!~;\[(@]", req.strip(), maxsplit=1)[0].lower().replace("_", "-")


def _install(requirements, log) -> list:
    """pip install what the skill needs and Emkay does not have; returns problems."""
    import importlib.metadata
    from . import pip
    problems = []
    for req in requirements or []:
        req = req.strip()
        if not req or req.startswith("#"):
            continue
        name = _requirement_name(req)
        if name in ALREADY_THERE:
            continue
        try:
            importlib.metadata.version(name)
            continue   # installed; the dev loop does not upgrade behind your back
        except importlib.metadata.PackageNotFoundError:
            pass
        log(f"installing {req} …")
        try:
            out = pip.run(["install", req], print_logs=False)
            log(out.strip().splitlines()[-1] if out.strip() else f"installed {req}")
        except Exception as e:   # pip.PipError: what pip would have printed
            problems.append(f"{req}: {e}")
            log(f"could not install {req}: {e}")
    return problems


def _manager():
    from . import boot
    return getattr(boot, "_manager", None)


async def load(skill_id: str, files_json: str, requirements_json: str = "[]") -> str:
    """(Re)load a skill from its files.

    Args:
        skill_id: the skill's id, as in its opm.skill entry point
            ("ovos-skill-hello.yourname").
        files_json: {"relative/path": "<base64>", ...} - the skill's package
            folder: __init__.py, locale/, gui/, ...
        requirements_json: ["requests", ...] - its dependencies.

    Returns once padatious has learned the skill's sentences (so the next
    utterance can reach it), as JSON: {ok, skill_id, seconds, trained,
    intents, problems, log}.
    """
    import asyncio
    import base64
    from ovos_bus_client.message import Message
    from ovos_workshop.skill_launcher import SkillLoader
    from . import boot

    t0 = time.time()
    lines = []
    log = lines.append
    if not SKILL_ID.match(skill_id or ""):
        return json.dumps({"ok": False, "skill_id": skill_id,
                           "problems": [f"not a skill id: {skill_id!r}"], "log": []})
    files = json.loads(files_json)
    if "__init__.py" not in {_safe_path(p).replace(os.sep, "/") for p in files}:
        return json.dumps({"ok": False, "skill_id": skill_id,
                           "problems": ["no __init__.py in the skill folder"], "log": []})

    problems = _install(json.loads(requirements_json or "[]"), log)

    # the running copy out first: the dev copy before, or a store-installed one
    unload(skill_id, quiet=True)
    manager = _manager()
    if manager is not None and skill_id in getattr(manager, "plugin_skills", {}):
        log(f"the installed {skill_id} rests while you develop it")
        manager._unload_plugin_skill(skill_id)
        _replaced[skill_id] = True

    folder = os.path.join(DEV_ROOT, skill_id)
    shutil.rmtree(folder, ignore_errors=True)
    for rel, b64 in files.items():
        path = os.path.join(folder, _safe_path(rel))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
    log(f"{len(files)} files written")

    # what the skill registers while it loads: its intents and vocabulary
    seen = []

    def watch(raw):
        msg = json.loads(raw) if isinstance(raw, str) else json.loads(raw.serialize())
        t = msg.get("type", "")
        d = msg.get("data") or {}
        if t in ("padatious:register_intent", "padatious:register_entity"):
            seen.append(d.get("name"))
        elif t == "register_intent":
            seen.append(d.get("name"))

    global _capture
    _capture = []
    bus = boot.bus()
    bus.on("message", watch)
    module = skill_id.replace(".", "_")
    _watching.add(module)
    try:
        loader = SkillLoader(bus, folder, skill_id)
        ok = bool(loader.load())
    except Exception as e:
        import traceback
        ok, loader = False, None
        problems.append(f"{type(e).__name__}: {e}")
        log(traceback.format_exc())
    finally:
        bus.remove("message", watch)
    if loader is not None:
        _loaders[skill_id] = loader
    errors, _capture = _capture, None
    if not ok and not problems:
        # the first error the load logged says it best ("Failed to load skill:
        # ... (name 'x' is not defined)"); the traceback is in the log
        problems.append(errors[0] if errors else
                        "the skill did not load - see the Emkay log for the traceback")
    trained = None
    if ok:
        # padatious learns the new sentences (as after an install); until it
        # has, they would go to other skills, so wait for it (a few seconds)
        done = asyncio.Event()
        on_trained = lambda _m: done.set()
        bus.on("mycroft.skills.trained", on_trained)
        t1 = time.time()
        bus.emit(Message("mycroft.skills.train", {"lang": None}))
        try:
            await asyncio.wait_for(done.wait(), 90)
            trained = round(time.time() - t1, 2)
        except asyncio.TimeoutError:
            log("padatious did not say it finished learning within 90 s")
        finally:
            bus.remove("mycroft.skills.trained", on_trained)
        bus.emit(Message("mycroft.skill.loaded", {"skill_id": skill_id}))
    return json.dumps({"ok": ok, "skill_id": skill_id, "trained": trained,
                       "seconds": round(time.time() - t0, 2),
                       "intents": sorted({i for i in seen if i}),
                       "problems": problems, "log": lines})


def unload(skill_id: str, quiet: bool = False, restore: bool = False) -> str:
    """Stop the dev copy of a skill; with restore, load the installed one again."""
    loader = _loaders.pop(skill_id, None)
    if loader is not None:
        try:
            loader._unload()
        except Exception:
            logging.getLogger("emkay.dev").exception("unloading %s", skill_id)
    if restore and _replaced.pop(skill_id, None):
        manager = _manager()
        if manager is not None:
            manager._load_new_skills()
    return "" if quiet else json.dumps({"ok": True, "skill_id": skill_id})


def loaded() -> str:
    """The skills running from dev files."""
    return json.dumps(sorted(_loaders))


def language() -> str:
    """The language Emkay speaks now (what its sentences are tested in)."""
    from ovos_config import Configuration
    return Configuration().get("lang", "en-US")


def skills() -> str:
    """Every skill id Emkay runs (installed and dev), for the test judge."""
    manager = _manager()
    ids = set(getattr(manager, "plugin_skills", {}) or {}) | set(_loaders)
    return json.dumps(sorted(ids))


# --------------------------------------------------------------- testing

#: Done with a step: the utterance was handled, or nobody took it.
_STEP_ENDS = ("ovos.utterance.handled", "ovos.intent.unmatched", "complete_intent_failure")

#: ... or the skill that took it asks something back (get_response,
#: ask_yesno): who took the sentence is known, and the answer would only come
#: from the user. The question is then called off (_call_off).
_ASKS = ("mycroft.mic.listen",)
_ASKS_SUFFIX = ".get_response.waiting"


def _call_off(bus, skill_ids, sess):
    """End what a test started: a question the skill is waiting on
    (mycroft.skills.abort_question, which get_response reacts to) and the rest
    (mycroft.stop)."""
    from ovos_bus_client.message import Message
    ctx = {"session": sess.serialize()}
    for sid in skill_ids:
        bus.emit(Message("mycroft.skills.abort_question", {"skill_id": sid}, ctx))
    bus.emit(Message("mycroft.stop", {}, ctx))


async def test(row_json: str, timeout: float = 20.0) -> str:
    """Send one golden utterance and judge who took it.

    `row_json` is one row of a skill's test/end2end/golden_utterances_<lang>.jsonl
    ({"skill_id", "utterance", "lang", "intent_label"}), or {"utterance"}
    alone to just see who answers. The verdict comes from ovos-routing-judge,
    the same judge ovos-tui-client and the Emkay store's CI use, so a row
    passes or fails here exactly as it does there.

    A row in another language than Emkay speaks is skipped: padatious has
    learned the sentences of Emkay's language only.

    Returns JSON: {status: pass|fail|timeout|sent|skipped, kind, detail, spoke, seconds}.
    """
    import asyncio
    import uuid
    from ovos_bus_client.message import Message
    from ovos_bus_client.session import Session, SessionManager
    from ovos_routing_judge import Claim, judge, HIT, HANG
    from ovos_config import Configuration
    from . import boot

    row = json.loads(row_json)
    text = row.get("utterance", "")
    speaks = Configuration().get("lang", "en-US")
    lang = row.get("lang") or speaks
    if lang.split("-")[0].lower() != speaks.split("-")[0].lower():
        # padatious has learned the sentences of Emkay's own language only
        return json.dumps({"status": "skipped", "kind": "", "spoke": [], "seconds": 0,
                           "detail": f"Emkay speaks {speaks}; this sentence is {lang} "
                                     f"(change Emkay's language in Settings to test it)"})
    skill_id = row.get("skill_id")
    label = row.get("intent_label")
    expected = f"{skill_id}:{label}" if skill_id and label else None
    known = set(json.loads(skills()))

    # a session of its own, from the default one (location, pipeline, ...)
    base = SessionManager.get_default_session().serialize()
    base["session_id"] = "emkay-dev-" + uuid.uuid4().hex[:8]
    base["lang"] = lang
    sess = Session.deserialize(base)
    sid = sess.session_id

    claim = Claim(session_id=sid)
    spoke, done, asked = [], asyncio.Event(), set()

    def watch(raw):
        msg = json.loads(raw) if isinstance(raw, str) else json.loads(raw.serialize())
        claim.observe(msg, known | ({skill_id} if skill_id else set()))
        ctx_sess = (msg.get("context") or {}).get("session") or {}
        if ctx_sess.get("session_id") != sid:
            return
        t = msg.get("type", "")
        if t in ("speak", "ovos.utterance.speak"):
            spoke.append((msg.get("data") or {}).get("utterance", ""))
        if t in _STEP_ENDS or t in _ASKS or t.endswith(_ASKS_SUFFIX):
            if t.endswith(_ASKS_SUFFIX):
                asked.add(t[:-len(_ASKS_SUFFIX)])
            done.set()

    bus = boot.bus()
    bus.on("message", watch)
    t0 = time.time()
    hung = False
    try:
        # handed over: a handler that asks something back waits for the
        # answer (JSPI), and this test must not wait with it
        from .browser import hand_over
        hand_over(lambda: boot.utterance(text, lang=lang, session=sess))
        try:
            await asyncio.wait_for(done.wait(), timeout)
        except asyncio.TimeoutError:
            hung = True
        await asyncio.sleep(0.3)   # a reply spoken right after "handled"
    finally:
        bus.remove("message", watch)
        _call_off(bus, asked | ({skill_id} if skill_id else set()), sess)

    if not skill_id:
        status = "timeout" if hung and claim.empty else "sent"
        from ovos_routing_judge.judge import describe
        return json.dumps({"status": status, "kind": "", "detail": describe(claim),
                           "spoke": spoke, "seconds": round(time.time() - t0, 2)})
    v = judge(claim, [skill_id], expected=expected, intent_type=row.get("intent_type"),
              hung=hung, known_ids=known | {skill_id}, strict_known=False)
    if v.kind == HIT:
        status, detail = "pass", expected or skill_id
    elif v.kind == HANG:
        status, detail = "timeout", v.detail or "no response"
    else:
        status = "fail"
        detail = f"expected {expected or skill_id}, got {v.detail}"
    return json.dumps({"status": status, "kind": v.kind, "detail": detail,
                       "spoke": spoke, "seconds": round(time.time() - t0, 2)})
