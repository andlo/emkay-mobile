"""Where the local OVOS hears and speaks, for the page's privacy chip
(web/privacy.js).

The page decides what "on this device", "in your home" and "elsewhere"
means; this side only says which plugins are configured and, for the
plugins that talk to a server, which servers they use – read from
mycroft.conf the same way the plugins themselves read it. The fallback
plugins are included: speech.py falls back to them when a model on the
device isn't ready yet, and the page then shows where they go.
"""

#: the config keys plugins use for the servers they talk to
_HOST_KEYS = ("url", "urls", "host", "hosts", "server", "servers", "endpoint", "api_url")


def _hosts(plugin_cfg) -> list:
    """The servers in a plugin's own settings; [] when none are set (a
    server plugin then uses its own default servers)."""
    out = []
    for key in _HOST_KEYS:
        v = (plugin_cfg or {}).get(key)
        if isinstance(v, str) and v:
            out.append(v)
        elif isinstance(v, (list, tuple)):
            out += [x for x in v if isinstance(x, str) and x]
    return out


def _part(section: dict, module_key: str = "module") -> dict:
    module = section.get(module_key)
    return {"module": module, "hosts": _hosts(section.get(module)) if module else []}


def route() -> dict:
    """{stt, stt_fallback, tts, tts_fallback}: each {module, hosts}."""
    from ovos_config import Configuration
    cfg = Configuration()
    stt, tts = cfg.get("stt", {}), cfg.get("tts", {})
    return {"stt": _part(stt), "stt_fallback": _part(stt, "fallback_module"),
            "tts": _part(tts), "tts_fallback": _part(tts, "fallback_module")}
