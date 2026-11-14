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

# Pipeline stages that need native code with no WebAssembly build yet.
UNAVAILABLE_PIPELINES = ("ovos-m2v-pipeline-high", "ovos-m2v-pipeline-medium",
                         "ovos-m2v-pipeline-low")

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
    from ovos_config import Configuration
    cfg = Configuration()
    pipeline = [p for p in cfg.get("intents", {}).get("pipeline", [])
                if p not in UNAVAILABLE_PIPELINES]
    blacklisted = list(cfg.get("skills", {}).get("blacklisted_skills", []))
    blacklisted += [s for s in UNAVAILABLE_SKILLS if s not in blacklisted]
    return {"intents": {"pipeline": pipeline},
            "skills": {"blacklisted_skills": blacklisted}}


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
    if "pipeline" not in user.get("intents", {}):
        write_user_config(_browser_defaults())
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
