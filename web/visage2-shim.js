// Emkay – the new visage's websockets, inside its frame (web/visage2/).
//
// ovos-gui-visage's web build connects, relative to its page, to
//   core  the OVOS messagebus
//   gui   ovos-gui's legacy GUI socket (after mycroft.gui.port on the bus)
//   gui1  the GUI-1 adapter (ovos-gui-plugin-visage), probed first
// On a device its nginx sidecar proxies those to OVOS. Here OVOS runs in the
// Emkay page's worker, so this script, loaded before Flutter starts, makes
// WebSocket hand those three URLs to EmkaySocket, which talks to the parent
// page (app.js: window.emkayVisage2). gui1 fails at once, so the app's
// `auto` protocol falls back to legacy, as it does on a device without the
// adapter. Any other URL gets the browser's own WebSocket.
//
// EmkaySocket is made in this frame, with this frame's EventTarget, Event
// and MessageEvent, so the app's checks on the events it gets hold.
(() => {
  const host = parent !== window ? parent.emkayVisage2 : null;
  if (!host) return;   // opened on its own: nothing to talk to
  const Native = window.WebSocket;
  const ROUTES = /\/(core|gui1?)$/;

  class EmkaySocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.route = new URL(this.url, location.href).pathname.match(ROUTES)[1];
      this.readyState = 0;
      this.protocol = "";
      this.extensions = "";
      this.bufferedAmount = 0;
      this.binaryType = "blob";
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      this.listener = (raw) => {
        if (this.readyState === 1) this.fire(new MessageEvent("message", { data: raw }));
      };
      setTimeout(() => this.connect(), 0);
    }
    fire(event) {
      this.dispatchEvent(event);
      this["on" + event.type]?.call(this, event);
    }
    async connect() {
      if (this.route === "gui1") return this.fail();   // no GUI-1 adapter (yet)
      await host.ready;                                 // OVOS is up
      // the bus forwards everything from here on, before the app may speak
      if (this.route === "core") await host.call("core_open", { open: true });
      if (this.readyState !== 0) return;
      this.readyState = 1;
      host.subscribe(this.route, this.listener);
      this.fire(new Event("open"));
    }
    fail() {
      this.readyState = 3;
      this.fire(new Event("error"));
      this.fire(new CloseEvent("close", { code: 1006, wasClean: false }));
    }
    send(data) {
      if (this.readyState !== 1) throw new DOMException("WebSocket is not open", "InvalidStateError");
      const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
      if (this.route === "core") return void host.call("core_send", { raw });
      // the GUI socket: ovos-gui's GUIWebsocketHandler.on_message, and on the
      // app's hello the state replay a new connection gets in its open()
      host.call("gui_message", { raw });
      if (JSON.parse(raw).type === "mycroft.gui.connected") host.call("gui_sync");
    }
    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      host.unsubscribe(this.route, this.listener);
      if (this.route === "core") host.call("core_open", { open: false });
      this.fire(new CloseEvent("close", { code, reason, wasClean: true }));
    }
  }
  for (const [k, v] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    EmkaySocket[k] = v;
    EmkaySocket.prototype[k] = v;
  }

  // Tap-to-talk, as on the old visage, where the whole screen is the button
  // (app.js). The frame gets the taps now, so it hands them on. ovos-gui-visage
  // has no "listen" action of its own yet; until it has, a tap on one of its
  // own controls also starts listening.
  let down = null;
  addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; }, true);
  addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!d || e.timeStamp - d.t > 500 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;  // a drag
    host.tap?.();
  }, true);

  window.WebSocket = new Proxy(Native, {
    construct(target, args) {
      const path = new URL(String(args[0]), location.href).pathname;
      return ROUTES.test(path) ? new EmkaySocket(args[0]) : new target(...args);
    },
  });
})();
