// Emkay – the connection to Home Assistant, whatever Emkay thinks with.
//
// One address, one login, used for everything Emkay does with Home
// Assistant (#29, andlo/ha-ovos-integration):
//
//   - Home Assistant as the brain (brains/homeassistant-brain.js)
//   - Emkay with its own OVOS, connected to Home Assistant (ha-device.js):
//     Emkay is a device in HA (volume, sensors, the control panel, the
//     network log), and what HA's Assist recognizes goes to HA
//     (ovos-assist-pipeline-plugin)
//
// Login is HA's own login page (OAuth2 / IndieAuth with Emkay's address as
// client_id) – nobody copies a token. The refresh token stays in this
// browser ("emkay-ha" in localStorage).

import { t } from "./i18n.js";
import { setBrain } from "./brains/saved.js";

const KEY = "emkay-ha";
const STATE_KEY = "emkay-ha-login";      // sessionStorage: the login's state value
/** The state's prefix says what the login was for: the brain, or the link. */
export const LOGIN_BRAIN = "emkay-ha.";
export const LOGIN_LINK = "emkay-ha-link.";

/** Settings from localStorage: {url, refresh, device_id, name, pipeline}. */
export function haSettings() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null") || {}; } catch { return {}; }
}
export function saveHaSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

/** "homeassistant.local:8123" -> "http(s)://homeassistant.local:8123" */
export function normalizeUrl(raw) {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `${location.protocol === "https:" ? "https" : "http"}://${u}`;
  try { return new URL(u).origin; } catch { return ""; }
}

/** Emkay's identity towards HA's login: its own address (IndieAuth). */
const clientId = () => `${location.origin}/`;
const redirectUri = () => `${location.origin}${location.pathname}`;

/** Off to HA's login page; it comes back here with ?code=…&state=… */
export function goLogin(url, kind = LOGIN_BRAIN) {
  const state = `${kind}${crypto.randomUUID()}`;
  try { sessionStorage.setItem(STATE_KEY, state); } catch {}
  const q = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri(), state });
  location.assign(`${url}/auth/authorize?${q}`);
}

/** Back from HA's login page: the code, once (and dropped from the address). */
export function takeLoginCode(kind = LOGIN_BRAIN) {
  const p = new URLSearchParams(location.search);
  const code = p.get("code"), state = p.get("state");
  if (!code || !state?.startsWith(kind)) return null;
  let expected = null;
  try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch {}
  history.replaceState(null, "", location.pathname);
  return state === expected ? code : null;
}

export async function token(url, form) {
  const r = await fetch(`${url}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), ...form }),
  });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: r.status === 400 ? "login" : "unreachable" });
  return r.json();
}

/**
 * Ask for HA's address in a small form over the boot screen, as the
 * HiveMind brain does. Resolves with the address, or null (Back).
 */
export function askHaUrl(prev = "", error = "", { back = false, local = false } = {}) {
  return new Promise((resolve) => {
    document.getElementById("ha-setup")?.parentElement.remove();
    // the same card as the menu and "Where should Emkay think?"
    const box = document.createElement("div");
    box.className = "menu setup";
    const form = document.createElement("form");
    form.id = "ha-setup";
    form.className = "menu-card setup-card";
    box.append(form);
    form.innerHTML = `
      <h2 class="with-icon"><img src="menu/brain.svg" alt="">${t("ha.title")}</h2>
      <p>${t("ha.hint")}</p>
      ${error ? `<p class="error"></p>` : ""}
      <label>${t("ha.url")}<input name="url" type="text" value="" required autocapitalize="off"
        spellcheck="false" inputmode="url" placeholder="https://homeassistant.local:8123"></label>
      <button type="submit">${t("ha.login")}</button>
      ${back ? `<button type="button" class="secondary" data-act="back">${t("hivemind.back")}</button>` : ""}
      ${local ? `<button type="button" class="secondary" data-act="local">${t("hivemind.use_local")}</button>` : ""}`;
    form.querySelector("input").value = prev;
    if (error) form.querySelector(".error").textContent = error;   // text, not HTML
    form.querySelector('[data-act="back"]')?.addEventListener("click", () => { box.remove(); resolve(null); });
    form.querySelector('[data-act="local"]')?.addEventListener("click", () => {
      setBrain("local");
      location.replace(location.pathname);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const url = normalizeUrl(new FormData(form).get("url"));
      if (!url) return;
      if (location.protocol === "https:" && url.startsWith("http:")) {
        form.querySelector(".error")?.remove();
        const p = document.createElement("p");
        p.className = "error";
        p.textContent = t("ha.needs_https");
        form.querySelector("p").after(p);
        return;
      }
      box.remove();
      resolve(url);
    };
    document.body.append(box);
  });
}

/** HA's WebSocket API: commands, subscriptions, binary audio. */
export class HaSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url.replace(/^http/, "ws") + "/api/websocket";
    this.nextId = 1;
    this.waiting = new Map();   // id -> {resolve, reject}
    this.subs = new Map();      // id -> fn(event)
  }

  open(accessToken) {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      const fail = () => reject(Object.assign(new Error("closed"), { code: "unreachable" }));
      ws.onerror = fail;
      ws.onclose = () => { fail(); this.dispatchEvent(new Event("close")); };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: accessToken }));
        else if (msg.type === "auth_ok") { this.version = msg.ha_version; resolve(); }
        else if (msg.type === "auth_invalid") reject(Object.assign(new Error(msg.message), { code: "login" }));
        else if (msg.type === "result") {
          const w = this.waiting.get(msg.id);
          this.waiting.delete(msg.id);
          if (w) msg.success ? w.resolve(msg.result) : w.reject(Object.assign(new Error(msg.error?.message), { code: msg.error?.code }));
        } else if (msg.type === "event") this.subs.get(msg.id)?.(msg.event);
      };
    });
  }

  command(msg) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, ...msg }));
    });
  }

  /** A subscription: resolves with its id once HA accepted it. */
  async subscribe(msg, onEvent) {
    const id = this.nextId;
    this.subs.set(id, onEvent);
    try { await this.command(msg); } catch (e) { this.subs.delete(id); throw e; }
    return id;
  }

  unsubscribe(id) {
    this.subs.delete(id);
    this.command({ type: "unsubscribe_events", subscription: id }).catch(() => {});
  }

  /** Audio for a pipeline run: the handler id's byte, then the PCM. */
  sendAudio(handler, bytes) {
    const out = new Uint8Array(1 + (bytes?.byteLength || 0));
    out[0] = handler;
    if (bytes) out.set(new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength), 1);
    this.ws.send(out);
  }

  close() { this.ws?.close(); }
}
