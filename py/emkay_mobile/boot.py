"""Boot a stock ovos-core on an in-process FakeBus.

This is ovos_core.__main__.main() without the websocket: the same SkillManager
and IntentService, the same skills and pipeline plugins, the same mycroft.conf
layering. The page talks to the bus through emit()/the listener it registers.
"""
import json
import os
import time

import sys

from . import browser

if sys.platform == "emscripten":
    browser.install()

# Where the worker unpacks the m2v intent models it fetched from the site,
# one folder per language (see tools/fetch_m2v_models.py).
M2V_DIR = os.path.expanduser("~/.local/share/emkay-mobile/m2v")

# Skills that wait for host services a browser does not have (they loop
# until ovos-audio/ovos-dinkum-listener report ready).
UNAVAILABLE_SKILLS = ("ovos-skill-boot-finished.openvoiceos",)

CONF_PATH = os.path.expanduser("~/.config/mycroft/mycroft.conf")

_bus = None
_manager = None


def write_user_config(overrides: dict):
    """Merge overrides into the user mycroft.conf, as the setup page does."""
    os.makedirs(os.path.dirname(CONF_PATH), exist_ok=True)
    cur = {}
    if os.path.exists(CONF_PATH):
        try:
            with open(CONF_PATH) as f:
                cur = json.load(f)
        except Exception:
            cur = {}

    def merge(a, b):
        for k, v in b.items():
            if isinstance(v, dict) and isinstance(a.get(k), dict):
                merge(a[k], v)
            else:
                a[k] = v
        return a

    merge(cur, overrides or {})
    with open(CONF_PATH, "w") as f:
        json.dump(cur, f, indent=2)
    return cur


def _browser_defaults():
    """The few settings that differ from a device, as a user layer."""
    from ovos_config import Configuration
    cfg = Configuration()
    blacklisted = list(cfg.get("skills", {}).get("blacklisted_skills", []))
    blacklisted += [s for s in UNAVAILABLE_SKILLS if s not in blacklisted]
    out = {"skills": {"blacklisted_skills": blacklisted}}
    # m2v: the per-language "models" map ovos-m2v-pipeline documents, pointed
    # at the copies the site ships (the Hub default is 141 MB for every
    # language, too much for a phone)
    if os.path.isdir(M2V_DIR):
        models = {lang: os.path.join(M2V_DIR, lang) for lang in sorted(os.listdir(M2V_DIR))
                  if os.path.isfile(os.path.join(M2V_DIR, lang, "model.safetensors"))}
        if models:
            out["intents"] = {"ovos_m2v_pipeline": {"models": models}}
    return out


def start(on_message=None, user_config=None):
    """Load every installed skill and return the bus."""
    global _bus, _manager
    t0 = time.time()
    if user_config:
        write_user_config(user_config)
    from ovos_config import Configuration
    from ovos_utils.fakebus import FakeBus
    from ovos_bus_client.message import Message

    # keep the user's own pipeline if the setup page wrote one
    user = {}
    if os.path.exists(CONF_PATH):
        with open(CONF_PATH) as f:
            user = json.load(f)
    defaults = _browser_defaults()
    if user.get("emkay_mobile_defaults"):
        # set once, so the setup page can change them; the m2v model paths
        # follow whatever the site shipped this time
        defaults = {k: v for k, v in defaults.items() if k == "intents"}
    write_user_config({**defaults, "emkay_mobile_defaults": 1})
    Configuration.reload()

    from ovos_core.skill_manager import SkillManager
    _bus = FakeBus()
    if on_message is not None:
        _bus.on("message", on_message)
    _manager = SkillManager(_bus,
                            enable_file_watcher=False,
                            enable_installer=False,
                            enable_event_scheduler=False,
                            enable_skill_api=True,
                            enable_intent_service=True)
    _manager._load_new_skills()
    _bus.emit(Message("mycroft.skills.initialized"))
    _manager.status.set_ready()
    loaded = sorted(_manager.plugin_skills.keys())
    return {"seconds": round(time.time() - t0, 2), "skills": loaded,
            "skipped_threads": list(browser.STARTED)}


def utterance(text, lang=None, session=None):
    """Send what the user said, exactly like the listener does."""
    from ovos_bus_client.message import Message
    from ovos_bus_client.session import SessionManager
    from ovos_config import Configuration
    lang = lang or Configuration().get("lang", "en-US")
    sess = session or SessionManager.get_default_session()
    _bus.emit(Message("recognizer_loop:utterance",
                      {"utterances": [text], "lang": lang},
                      {"session": sess.serialize(), "source": "emkay-mobile",
                       "destination": "skills"}))


def emit(msg_type, data=None, context=None):
    from ovos_bus_client.message import Message
    _bus.emit(Message(msg_type, data or {}, context or {}))


def bus():
    return _bus
