"""The GUI half: a stock ovos-gui NamespaceManager with the browser as its client.

On a normal device ovos-gui-service listens on ws://...:18181/gui and every
GUI (mycroft-gui, ovos-visage, ...) connects to it as a websocket client.
ovos-gui keeps its clients in GUIWebsocketHandler.clients and only calls
.send(dict), .framework and .send_gui_pages(...) on them (the last one is
GUIWebsocketHandler's own, borrowed in start()), so the browser joins that
list as an in-process client: no server, no socket, same GUI protocol.

The page hands this stream to ovos-gui-visage as its legacy GUI socket
(web/visage2-shim.js); on a (re)connect, worker_main.gui_sync replays the
state as GUIWebsocketHandler.open() does.
"""
import json

_client = None


class BrowserGuiClient:
    """Stands in for one GUIWebsocketHandler connection."""

    def __init__(self, ns_manager, post):
        self.ns_manager = ns_manager
        self._post = post            # callable(str): hands JSON to the page
        self._framework = "html"     # ovos-gui-visage announces framework=html

    @property
    def framework(self):
        return self._framework

    # --- what ovos-gui calls -------------------------------------------
    def send(self, message: dict):
        self._post(json.dumps(message))

    def write_message(self, payload, *a, **k):
        self.send(json.loads(payload) if isinstance(payload, str) else payload)

    # --- what the page calls --------------------------------------------
    def from_page(self, raw: str):
        """A GUI-protocol message from the page (focus, events, set)."""
        from ovos_gui.bus import GUIWebsocketHandler
        msg = json.loads(raw)
        GUIWebsocketHandler.on_message(self, json.dumps(msg))


def start(bus, post):
    """Boot the namespace manager on the core bus and attach the browser."""
    global _client
    from ovos_gui.bus import GUIWebsocketHandler
    from ovos_gui import namespace as ns_module
    # NamespaceManager starts the tornado websocket server GUIs connect to.
    # A browser cannot listen on a port, and the browser is the GUI client
    # anyway, so the server is left out.
    ns_module.create_gui_service = lambda _ns_manager: None
    # the stock page-list sender; it only uses .framework and .send()
    BrowserGuiClient.send_gui_pages = GUIWebsocketHandler.send_gui_pages
    ns = ns_module.NamespaceManager(bus)
    _client = BrowserGuiClient(ns, post)
    GUIWebsocketHandler.clients.append(_client)
    from ovos_bus_client.message import Message
    bus.emit(Message("mycroft.gui.connected", {"gui_id": "emkay", "framework": "html"}))
    GUIWebsocketHandler.synchronize(_client)
    return _client


def client():
    return _client
