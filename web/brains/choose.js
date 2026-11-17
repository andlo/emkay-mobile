// Emkay – "Where should Emkay think?" (#27): the choice of brain, from the
// ⚙ menu or the first start's "Already have an assistant in the house?".
//
// Emkay always starts without a choice: on this device, the default. A
// choice is saved (brains/brain.js setBrain) and Emkay starts again in it;
// the local OVOS that may be loading meanwhile is simply left behind.

import { t, apply } from "../i18n.js";
import { setBrain } from "./brain.js";
import { askHivemindSettings, hivemindSettings, saveHivemindSettings } from "./hivemind-brain.js";

const OPTIONS = [
  { kind: "local", icon: "icon.svg" },
  { kind: "hivemind", icon: "menu/brain.svg" },
  { kind: "homeassistant", icon: "menu/brain.svg", soon: true },   // #29
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
      if (o.kind === current) { box.remove(); return onClose(); }
      switchTo(o.kind);
    };
    card.append(b);
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

/** The menu entry's line: what Emkay thinks with now. */
export function brainHint(current) {
  if (current === "hivemind") return t("menu.brain.hint.hivemind", { host: hivemindSettings()?.host || "" });
  return t(`menu.brain.hint.${current}`);
}

export { switchTo };
