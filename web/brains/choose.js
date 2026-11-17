// Emkay – "Where should Emkay think?" (#27): the choice of brain, from the
// ⚙ menu or the first start's "Already have an assistant in the house?".
//
// Emkay always starts without a choice: on this device, the default. A
// choice is saved (brains/brain.js setBrain) and Emkay starts again in it;
// the local OVOS that may be loading meanwhile is simply left behind.

import { t, apply } from "../i18n.js";
import { setBrain } from "./brain.js";
import { askHivemindSettings, hivemindSettings, saveHivemindSettings } from "./hivemind-brain.js";
import { askHaUrl, haSettings, saveHaSettings } from "./homeassistant-brain.js";
import { dropHaLink, wantHaLink } from "../ha-device.js";

const OPTIONS = [
  { kind: "local", icon: "icon.svg" },
  { kind: "hivemind", icon: "menu/brain.svg" },
  { kind: "homeassistant", icon: "menu/brain.svg" },   // #29
];

/** Start again in `kind` (a reload: one brain per page). */
function switchTo(kind) {
  setBrain(kind);
  location.replace(location.pathname);   // drops ?brain=… so the saved choice counts
}

/**
 * Show the choice over whatever is on screen.
 * @param {string} current  the brain this page runs
 * @param {() => void} [onClose]  called when closed without a change
 */
export function chooseBrain(current, onClose = () => {}) {
  document.getElementById("brain-choice")?.remove();
  const box = document.createElement("div");
  box.id = "brain-choice";
  box.className = "menu brain-choice";
  const card = document.createElement("div");
  card.className = "menu-card";
  card.innerHTML = `<h2 data-i18n="brain.title"></h2>`;
  for (const o of OPTIONS) {
    const b = document.createElement("button");
    b.className = "menu-item" + (o.kind === current ? " current" : "");
    b.disabled = !!o.soon;
    b.innerHTML = `<img src="${o.icon}" alt=""><span><b data-i18n="brain.${o.kind}"></b>` +
      `<small data-i18n="brain.${o.kind}.hint"></small></span>`;
    b.onclick = async () => {
      if (o.kind === "hivemind") {
        box.hidden = true;
        const s = await askHivemindSettings(hivemindSettings() || {}, "", { back: true });
        if (!s) { box.hidden = false; return; }
        saveHivemindSettings(s);
        return switchTo("hivemind");
      }
      if (o.kind === "homeassistant" && o.kind !== current) {
        box.hidden = true;
        const url = await askHaUrl(haSettings().url || "", "", { back: true });
        if (!url) { box.hidden = false; return; }
        // a new address: log in there (the brain sends the page to HA's login)
        const s = haSettings();
        saveHaSettings(url === s.url ? s : { ...s, url, refresh: null });
        return switchTo("homeassistant");
      }
      if (o.kind === current) { box.remove(); return onClose(); }
      switchTo(o.kind);
    };
    card.append(b);
    if (o.kind === "local") card.append(haLinkRow(box));
  }
  const close = document.createElement("button");
  close.className = "secondary";
  close.dataset.i18n = "close";
  close.onclick = () => { box.remove(); onClose(); };
  card.append(close);
  box.append(card);
  document.body.append(box);
  apply(box);
}

/**
 * Under "on this device": connect Emkay's own OVOS to Home Assistant (one
 * login with the Home Assistant brain, ha-link.js): Emkay shows up in HA,
 * and what HA's Assist recognizes – lights, heating – goes to HA.
 */
function haLinkRow(box) {
  const row = document.createElement("label");
  row.className = "check brain-sub";
  const on = !!haSettings().link;
  row.innerHTML = `<input type="checkbox" ${on ? "checked" : ""}>` +
    `<span><b data-i18n="ha.link"></b><small data-i18n="ha.link.hint"></small></span>`;
  row.querySelector("input").onchange = async (e) => {
    if (!e.target.checked) return dropHaLink();
    box.hidden = true;
    const url = await askHaUrl(haSettings().url || "", "", { back: true });
    if (!url) { e.target.checked = false; box.hidden = false; return; }
    setBrain("local");          // the link is for Emkay with its own OVOS
    wantHaLink(url);            // HA's login page, then back here
  };
  return row;
}

/** The menu entry's line: what Emkay thinks with now. */
export function brainHint(current) {
  if (current === "hivemind") return t("menu.brain.hint.hivemind", { host: hivemindSettings()?.host || "" });
  if (current === "homeassistant") return t("menu.brain.hint.homeassistant", { host: (haSettings().url || "").replace(/^https?:\/\//, "") });
  if (current === "local" && haSettings().link) {
    return t("menu.brain.hint.local_ha", { host: (haSettings().url || "").replace(/^https?:\/\//, "") });
  }
  return t(`menu.brain.hint.${current}`);
}

export { switchTo };
