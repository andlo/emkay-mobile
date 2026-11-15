"""Boot a stock ovos-core on an in-process bus.

This is `ovos_core.__main__.main()` without the websocket: the same
SkillManager, IntentService, pipeline plugins and skills, and the same
mycroft.conf layering. The messagebus service is replaced by ovos-utils'
FakeBus, which delivers every message to its handlers in the same process,
because a browser cannot open a server socket.

The page side talks to it through `utterance()`, `emit()` and `bus()`.
"""
import json
import os
import sys
import time

from . import browser

if sys.platform == "emscripten":
    browser.install()

#: Where the worker unpacks the m2v intent models it fetched from the site,
#: one folder per language (see tools/fetch_m2v_models.py).
M2V_DIR = os.path.expanduser("~/.local/share/emkay-mobile/m2v")

#: Skills that wait for host services a browser does not have: they loop
#: until ovos-audio and ovos-dinkum-listener report ready, which never happens.
UNAVAILABLE_SKILLS = ("ovos-skill-boot-finished.openvoiceos",)

#: Version of the one-time defaults below; each step is written once, so a
#: phone set up by an older build gets only the steps it has not had yet.
DEFAULTS_VERSION = 2

#: OVOS' own alpha-channel constraints, for what is installed later (the
#: site itself is built from the alpha channel).
ALPHA_CONSTRAINTS = ("https://raw.githubusercontent.com/OpenVoiceOS/ovos-releases/"
                     "refs/heads/main/constraints-alpha.txt")

#: The user layer of mycroft.conf, as on a device (~/.config/mycroft).
CONF_PATH = os.path.expanduser("~/.config/mycroft/mycroft.conf")

_bus = None
_manager = None


def _merge(base: dict, extra: dict) -> dict:
    """Merge `extra` into `base` in place, recursing into nested dicts."""
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def read_user_config() -> dict:
    """The user mycroft.conf as a dict ({} if there is none or it is broken)."""
    try:
        with open(CONF_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_user_config(overrides: dict) -> dict:
    """Merge `overrides` into the user mycroft.conf and return the result.

    This is what the setup page does on a device: the system and default
    layers stay untouched, the user layer holds only what was changed.
    """
    cur = _merge(read_user_config(), overrides or {})
    _write_whole_user_config(cur)
    return cur


def _write_whole_user_config(conf: dict):
    """Replace the user mycroft.conf (write_user_config only merges)."""
    os.makedirs(os.path.dirname(CONF_PATH), exist_ok=True)
    with open(CONF_PATH, "w") as f:
        json.dump(conf, f, indent=2)


def _m2v_models() -> dict:
    """{lang: folder} for every m2v model the worker unpacked."""
    if not os.path.isdir(M2V_DIR):
        return {}
    return {lang: os.path.join(M2V_DIR, lang) for lang in sorted(os.listdir(M2V_DIR))
            if os.path.isfile(os.path.join(M2V_DIR, lang, "model.safetensors"))}


def _unused_pipelines(user_blacklist) -> list:
    """intents.blacklisted_pipelines with every installed pipeline plugin the
    active pipeline does not use.

    ovos-core loads every installed pipeline plugin, used or not, "because a
    remote client/session may select a different pipeline at runtime" - and
    each one then takes part in every skill's intent registration. A phone
    has no remote sessions, and in WebAssembly the unused ones (padacioso,
    persona, common query, the adapt variants, legacy OCP) cost over half of
    the boot. ovos-core's own `intents.blacklisted_pipelines` setting opts
    them out. Recomputed every boot with ovos-core's own matching rule, so a
    plugin put back into `intents.pipeline` (setup page) is loaded again.
    """
    from ovos_config import Configuration
    from ovos_plugin_manager.pipeline import OVOSPipelineFactory
    try:
        from ovos_core.intent_services.service import _PIPELINE_MIGRATION_MAP as legacy
    except ImportError:
        legacy = {}
    active = [legacy.get(m, m) for m in Configuration().get("intents", {}).get("pipeline", [])]

    def used(plugin_id):
        return any(m == plugin_id or m.startswith(f"{plugin_id}-") for m in active)

    keep = [p for p in user_blacklist if not used(p)]  # never block an active one
    unused = [p for p in OVOSPipelineFactory.get_installed_pipeline_ids()
              if not used(p) and p not in keep]
    return keep + unused


def _browser_defaults(done: int) -> dict:
    """The few settings that differ from a device, as a user-layer patch.

    `done` is the defaults version this phone already has (0 on a first
    boot). Each one-time step is written once, so the setup page can change
    it later:
      1. skills that cannot run here are blacklisted
      2. ovos-core's installer is enabled, on the alpha channel, and the
         setup page's release channel is alpha to match: installing skills
         and plugins from the setup page is what a device can do (see
         pip.py), and the site itself is built from the alphas
    The m2v model folders and the unused pipeline plugins are written on
    every boot, since they follow whatever the site shipped and the
    pipeline the user chose.
    """
    from ovos_config import Configuration
    out = {"emkay_mobile_defaults": DEFAULTS_VERSION}
    if done < 1:
        cfg = Configuration()
        blacklisted = list(cfg.get("skills", {}).get("blacklisted_skills", []))
        blacklisted += [s for s in UNAVAILABLE_SKILLS if s not in blacklisted]
        out.setdefault("skills", {})["blacklisted_skills"] = blacklisted
    if done < 2:
        out.setdefault("skills", {})["installer"] = {
            "allow_pip": True, "allow_alphas": True, "constraints": ALPHA_CONSTRAINTS}
        out["webui"] = {"release_channel": "alpha"}
    # The location now comes from the browser PHAL plugin, in the assistant
    # layer like ipgeo's (phal.py). Builds of 2026-11-14 wrote the browser's
    # time zone into the user layer instead, where it would hide that; such
    # an entry, and only that, is dropped again.
    user = read_user_config()
    loc = user.get("location")
    if isinstance(loc, dict) and list(loc) == ["timezone"] and \
            loc["timezone"].get("code") == loc["timezone"].get("name"):
        del user["location"]
        _write_whole_user_config(user)
    user_bl = read_user_config().get("intents", {}).get("blacklisted_pipelines", [])
    out["intents"] = {"blacklisted_pipelines": _unused_pipelines(user_bl)}
    models = _m2v_models()
    if models:
        # ovos-m2v-pipeline's documented per-language "models" map, pointed at
        # the copies the site ships (its Hub default is 141 MB for every
        # language, too much for a phone)
        out["intents"]["ovos_m2v_pipeline"] = {"models": models}
    return out


def _follow_config_changes(bus):
    """Reload the merged mycroft.conf when a service announces a change.

    On a device every config file is watched (a watchdog thread), and the
    services also listen for `configuration.updated` and friends - that is
    Configuration.set_config_update_handlers, which ovos-gui's service
    calls. The browser has neither the watcher thread nor that service, so
    the bus half is registered here, with ovos-config's own handlers: a
    PHAL plugin or the setup page writing a layer and emitting
    `configuration.updated` is then seen at once, as on a device.
    """
    from ovos_config import Configuration
    Configuration.deregister_bus()
    Configuration.bus = bus
    bus.on("configuration.updated", Configuration.updated)
    bus.on("configuration.patch", Configuration.patch)
    bus.on("configuration.patch.clear", Configuration.patch_clear)
    bus.on("configuration.cache.clear", Configuration.clear_cache)


def _drive_scheduler(scheduler, every: float = 0.5):
    """Run the event scheduler's tick() on the event loop instead of its thread.

    ScheduledEventService.run() is `replay()` followed by `tick()` every
    TICK_SECONDS on its own thread. Here the thread is not started (see
    browser.FOREVER_LOOPS), so the same two calls are made from the loop.
    Skill timers, alarms and `schedule_event()` work as on a device.
    """
    import asyncio
    loop = asyncio.get_event_loop()
    try:
        scheduler.replay()
    except Exception as e:
        print(f"[emkay] scheduler replay failed: {e!r}", file=sys.stderr)

    def tick():
        try:
            scheduler.tick()
        except Exception as e:  # one bad schedule must not stop the clock
            print(f"[emkay] scheduler tick failed: {e!r}", file=sys.stderr)
        loop.call_later(every, tick)

    loop.call_later(every, tick)


def _browser_installer():
    """ovos-core's installer (SkillsStore) with pip.run for its subprocess.

    SkillsStore._run_pip is the one place the installer starts a process
    (pip or uv). Everything else it does stays as it is.
    """
    from ovos_core.skill_installer import SkillsStore
    from . import pip
    SkillsStore._run_pip = staticmethod(pip.run)
    SkillsStore.UV = None   # the command line it builds is then plain pip's


def start(on_message=None, user_config=None) -> dict:
    """Load every installed skill on a fresh bus.

    Args:
        on_message: optional callable for every bus message (serialized).
        user_config: optional dict merged into the user mycroft.conf first.

    Returns:
        {"seconds": boot time, "skills": loaded skill ids,
         "skipped_threads": thread names that were deferred or left out}
    """
    global _bus, _manager
    t0 = time.time()
    if user_config:
        write_user_config(user_config)
    from ovos_config import Configuration
    from ovos_utils.fakebus import FakeBus
    from ovos_bus_client.message import Message

    done = int(read_user_config().get("emkay_mobile_defaults") or 0)
    write_user_config(_browser_defaults(done))
    Configuration.reload()
    if sys.platform == "emscripten":
        browser.adapt_ovos()

    from ovos_core.skill_manager import SkillManager
    _bus = FakeBus()
    if on_message is not None:
        _bus.on("message", on_message)
    _follow_config_changes(_bus)
    if sys.platform == "emscripten":
        _browser_installer()
    _manager = SkillManager(_bus,
                            enable_file_watcher=False,   # nothing edits files behind OVOS here
                            enable_installer=True,       # ovos.pip.install, see pip.py
                            enable_event_scheduler=True,
                            enable_skill_api=True,
                            enable_intent_service=True)
    if _manager.event_scheduler is not None and sys.platform == "emscripten":
        _drive_scheduler(_manager.event_scheduler)
    # after an install or removal, SkillManager itself loads, reloads or
    # unloads skills (its handlers for ovos.pip.install.complete etc.)
    # SkillManager.run() minus its 30 s rescan loop (a service loop, see
    # browser.FOREVER_LOOPS): load the skills, then announce readiness.
    _manager._load_new_skills()
    _bus.emit(Message("mycroft.skills.initialized"))
    _manager.status.set_ready()
    loaded = sorted(_manager.plugin_skills.keys())
    return {"seconds": round(time.time() - t0, 2), "skills": loaded,
            "skipped_threads": list(browser.STARTED)}


def utterance(text: str, lang: str = None, session=None):
    """Put what the user said on the bus, the way ovos-dinkum-listener does."""
    from ovos_bus_client.message import Message
    from ovos_bus_client.session import SessionManager
    from ovos_config import Configuration
    lang = lang or Configuration().get("lang", "en-US")
    sess = session or SessionManager.get_default_session()
    _bus.emit(Message("recognizer_loop:utterance",
                      {"utterances": [text], "lang": lang},
                      {"session": sess.serialize(), "source": "emkay-mobile",
                       "destination": "skills"}))


def emit(msg_type: str, data: dict = None, context: dict = None):
    """Emit one message on the bus."""
    from ovos_bus_client.message import Message
    _bus.emit(Message(msg_type, data or {}, context or {}))


def bus():
    """The bus OVOS runs on (None before start())."""
    return _bus
