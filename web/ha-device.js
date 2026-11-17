// Emkay – with its own OVOS, connected to Home Assistant.
//
// "Where should Emkay think?" → on this device → "Connect to my Home
// Assistant". Emkay keeps thinking with its own OVOS, and through one
// connection to HA (ha-link.js, the general OpenVoiceOS integration,
// andlo/ha-ovos-integration):
//
//   - Emkay is a device in HA: what HA asks over the OVOS bus goes onto
//     Emkay's own bus, and Emkay's OVOS answers as any OVOS does (volume and
//     sensors from ovos-phal-plugin-browser, the mic from the listener…)
//   - HA reaches the control panel that runs in Emkay's worker (panel events)
//   - what Emkay sends out on the network goes to HA (ovos.network.request,
//     from the network log)
//   - what HA's Assist recognizes goes to HA: this page is the link that
//     ovos-assist-pipeline-plugin talks to (ovos.assist.*), so "turn on the
//     light in the kitchen" is HA's, and "who was Niels Bohr" stays OVOS'
//
// The page is the link, as ovos-phal-plugin-ha-link is on an ordinary OVOS.

import { HaSocket, LOGIN_LINK, goLogin, haSettings, saveHaSettings, takeLoginCode, token } from "./ha-link.js";

const PROTOCOL = 1;
const NETLOG_EVERY_MS = 15000;

/** Is Emkay set to connect to HA (with its own OVOS)? */
export const haLinkWanted = () => !!haSettings().link;

/** OVOS' da-dk -> HA's da (HA keeps a region only where it matters) */
function haLang(lang) {
  if (!lang) return undefined;
  const [base, region] = String(lang).replace("_", "-").toLowerCase().split("-");
  return (base === "pt" || base === "zh") && region ? `${base}-${region.toUpperCase()}` : base;
}

/**
 * Connect Emkay's own OVOS to HA, and keep it connected.
 * @param {import("./brains/brain.js").Brain} brain  the local brain
 * @param {{lang?: string, version?: string, onStatus?: (key: string, vars?: object) => void}} [opts]
 */
export function startHaDevice(brain, { lang, version, onStatus = () => {} } = {}) {
  let settings = haSettings();
  let ha = null, ready = false, forward = new Set(), haDeviceId = null;
  let lastNet = Date.now();   // only what goes out from now on

  /** A bus message onto Emkay's own OVOS. */
  const toOvos = (type, data = {}, context = {}) => brain.emit(type, data, context);
  /** A bus message to HA, if HA asked for this type. */
  const toHA = (msg) => {
    if (ready && forward.has(msg.type)) {
      ha.command({ type: "ovos/bus", device_id: settings.device_id,
                   message: { type: msg.type, data: msg.data || {}, context: msg.context || {} } })
        .catch(() => {});
    }
  };
  const available = () => toOvos("ovos.assist.available", { available: ready });

  async function login() {
    const code = takeLoginCode(LOGIN_LINK);
    if (code) {
      const tok = await token(settings.url, { grant_type: "authorization_code", code });
      settings = { ...settings, refresh: tok.refresh_token };
      saveHaSettings(settings);
      return tok.access_token;
    }
    if (!settings.refresh) {   // asked to connect, not logged in yet
      goLogin(settings.url, LOGIN_LINK);
      return new Promise(() => {});
    }
    try {
      return (await token(settings.url, { grant_type: "refresh_token", refresh_token: settings.refresh })).access_token;
    } catch (e) {
      if (e.code === "login") {   // revoked in HA: log in again
        saveHaSettings({ ...settings, refresh: null });
        goLogin(settings.url, LOGIN_LINK);
        return new Promise(() => {});
      }
      throw e;
    }
  }

  async function connect() {
    onStatus("ha.connecting", { url: settings.url });
    const access = await login();
    const sock = new HaSocket(settings.url);
    await sock.open(access);
    ha = sock;
    if (!settings.device_id) {
      settings = { ...settings, device_id: `emkay-${crypto.randomUUID()}` };
      saveHaSettings(settings);
    }
    try {
      await sock.subscribe({
        type: "ovos/connect", protocol: PROTOCOL, device_id: settings.device_id,
        name: settings.name || "Emkay", model: "Emkay", manufacturer: "Emkay",
        sw_version: version, lang,
        panel: true,              // the control panel in Emkay's worker
      }, onEvent);
    } catch (e) {
      sock.close();
      throw e;
    }
    sock.addEventListener("close", () => {
      ready = false;
      available();
      onStatus("ha.lost", { url: settings.url });
      setTimeout(reconnect, 3000);
    });
  }

  async function reconnect() {
    try { await connect(); } catch (e) {
      console.warn("[emkay] ha link", e);
      setTimeout(reconnect, 10000);
    }
  }

  function onEvent(ev) {
    switch (ev.type) {
      case "pending":
        ready = false;
        onStatus("ha.pending");
        break;
      case "ready":
        forward = new Set(ev.forward || []);
        haDeviceId = ev.device_id || null;
        ready = true;
        available();
        onStatus("ha.connected", { url: settings.url });
        break;
      case "bus":   // what HA asks of the device, onto Emkay's own bus
        if (ev.message?.type) toOvos(ev.message.type, ev.message.data, ev.message.context);
        break;
      case "panel":
        panel(ev);
        break;
      case "displaced":
      case "removed":
        ready = false;
        available();
        break;
    }
  }

  /** HA's call to the control panel in the worker (andlo/ha-ovos-integration#15). */
  async function panel({ id, method, path, body }) {
    let status = 400, out = { detail: "bad request" };
    if (/^\/[^]*$/.test(path || "") && !path.includes("..")) {
      const [p, query = ""] = path.split("?");
      try {
        const res = await brain.call("panel_request", {
          method, path: `/api${p}`, query,
          headers: [["content-type", "application/json"], ["sec-fetch-site", "same-origin"]],
          body: body != null && method !== "GET" ? new TextEncoder().encode(JSON.stringify(body)).buffer : null,
        });
        status = res.status;
        const text = new TextDecoder().decode(res.body);
        try { out = JSON.parse(text); } catch { out = { detail: text.slice(0, 500) }; }
      } catch (e) {
        status = 502; out = { detail: String(e.message || e) };
      }
    }
    ha.command({ type: "ovos/panel/response", device_id: settings.device_id,
                 request_id: id, status, body: out }).catch(() => {});
  }

  /** ovos-assist-pipeline-plugin's questions: answered here, by HA's Assist. */
  async function assist(msg) {
    const reply = (data) => toOvos(`${msg.type}.response`, data, {
      ...msg.context, source: msg.context?.destination, destination: msg.context?.source });
    const text = msg.data?.utterance || "";
    if (msg.type === "ovos.assist.recognize") {
      let data = { match: false, intent: null };
      if (ready) {
        try {
          const r = await ha.command({ type: "conversation/agent/homeassistant/debug",
            sentences: [text], language: haLang(msg.data?.lang), device_id: haDeviceId });
          const found = r?.results?.[0];
          if (found?.match) data = { match: true, intent: found.intent?.name ?? null };
        } catch (e) { console.warn("[emkay] assist recognize", e); }
      }
      return reply(data);
    }
    let data = { speech: null };
    try {
      const r = await ha.command({ type: "conversation/process", text,
        language: haLang(msg.data?.lang), agent_id: "conversation.home_assistant", device_id: haDeviceId });
      data = { speech: r?.response?.speech?.plain?.speech ?? null,
               response_type: r?.response?.response_type, conversation_id: r?.conversation_id };
    } catch (e) { console.warn("[emkay] assist process", e); }
    reply(data);
  }

  // every bus message of Emkay's own OVOS: the ones HA wants, and the
  // pipeline plugin's questions
  brain.call("core_open", { open: true }).catch(() => {});
  brain.onMessage((raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "ovos.assist.ping") return available();
    if (msg.type === "ovos.assist.recognize" || msg.type === "ovos.assist.process") return assist(msg);
    toHA(msg);
  });

  // the network log (netlog.js): what went out since last time
  setInterval(async () => {
    if (!ready || !forward.has("ovos.network.request")) return;
    const entries = await brain.call("net_log").catch(() => []);
    for (const e of entries || []) {
      if (e.t > lastNet) toHA({ type: "ovos.network.request", data: e });
    }
    lastNet = Math.max(lastNet, ...(entries || []).map((e) => e.t || 0));
  }, NETLOG_EVERY_MS);

  reconnect();
  return { stop() { ha?.close(); } };
}

/** Turn the link on: the address, then HA's login page (the page leaves). */
export function wantHaLink(url) {
  const s = haSettings();
  saveHaSettings({ ...s, url, link: true, refresh: url === s.url ? s.refresh : null });
  if (url !== s.url || !s.refresh) goLogin(url, LOGIN_LINK);
  else location.replace(location.pathname);
}

/** Turn it off (the login is kept for when it is turned on again). */
export function dropHaLink() {
  saveHaSettings({ ...haSettings(), link: false });
  location.replace(location.pathname);
}
