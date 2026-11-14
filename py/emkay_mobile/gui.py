"""The GUI half: a stock ovos-gui NamespaceManager with the browser as its client.

On a normal device ovos-gui-service listens on ws://...:18181/gui and every
GUI (mycroft-gui, ovos-visage, ...) connects to it as a websocket client.
ovos-gui keeps its clients in GUIWebsocketHandler.clients and only calls
.send(dict), .framework and .send_gui_pages(...) on them (the last one is
GUIWebsocketHandler's own, borrowed in start()), so the browser joins that
list as an in-process client: no server, no socket, same GUI protocol.

ovos-visage's own server-side state model (GuiState) runs here too, so its
frontend gets exactly the snapshot-then-deltas stream it gets from
ovos-visage's /ws endpoint.
"""
import json

_client = None


class BrowserGuiClient:
    """Stands in for one GUIWebsocketHandler connection."""

    def __init__(self, ns_manager, post):
        self.ns_manager = ns_manager
        self._post = post            # callable(str): hands JSON to the page
        self._framework = "html"     # ovos-visage announces framework=html
        self.state = None
        try:
            from ovos_visage.state import GuiState
            self.state = GuiState()
        except Exception as e:  # visage not installed: plain passthrough
            print(f"[emkay] ovos-visage state model unavailable: {e!r}")

    @property
    def framework(self):
        return self._framework

    # --- what ovos-gui calls -------------------------------------------
    def send(self, message: dict):
        if self.state is not None:
            try:
                self.state.apply(message)
            except Exception as e:
                print(f"[emkay] visage state could not apply {message.get('type')}: {e!r}")
        self._post(json.dumps(message))

    def write_message(self, payload, *a, **k):
        self.send(json.loads(payload) if isinstance(payload, str) else payload)

    # --- what the page calls --------------------------------------------
    def snapshot(self) -> str:
        state = self.state.snapshot() if self.state is not None else {}
        return json.dumps({"type": "visage.snapshot", "state": state,
                           "gui_connected": True})

    def from_page(self, raw: str):
        """A GUI-protocol message from the page (focus, events, set)."""
        from ovos_gui.bus import GUIWebsocketHandler
        msg = json.loads(raw)
        if msg.get("type") == "focus":  # ovos-visage's own focus shorthand
            msg = {"type": "mycroft.events.triggered", "namespace": msg["namespace"],
                   "event_name": "page_gained_focus",
                   "parameters": {"number": msg["number"], "skillId": msg["namespace"]}}
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
    bus.emit(Message("mycroft.gui.connected", {"gui_id": "emkay-mobile", "framework": "html"}))
    GUIWebsocketHandler.synchronize(_client)
    return _client


def client():
    return _client
