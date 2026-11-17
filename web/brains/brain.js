// Emkay – where Emkay thinks (issue #28, part of #27).
//
// The page is the body: the face (ovos-gui-visage), microphone, wake word,
// speaker, menu. The brain is the OpenVoiceOS it talks to:
//
//   local          OVOS in this browser (worker.js + Pyodide) – today's Emkay
//   hivemind       a hivemind-core in the house (#11)          – not yet
//   homeassistant  Home Assistant's Assist, through the general
//                  OVOS integration (andlo/ha-ovos-integration) – not yet
//
// The language between body and brain is the OVOS bus. Every brain hands
// the page bus messages (onMessage) and takes bus messages from it (emit),
// so the face and the rest of the page don't need to know which brain they
// have. Local and HiveMind speak the bus already; the Home Assistant brain
// will translate Assist pipeline events into the same messages.
//
// The local brain has more than the bus – the control panel, the skill
// store, the network log, ovos-gui – and says so in `can`; the page shows
// only what the brain can do.

/**
 * @typedef {object} Brain
 * @property {string} kind  "local" | "hivemind" | "homeassistant"
 * @property {{panel?: boolean, store?: boolean, install?: boolean,
 *             netlog?: boolean, gui?: boolean}} can  what it offers beyond the bus
 * @property {(type: string, data?: object, context?: object) => Promise<any>} emit
 *           send a bus message from the page
 * @property {(fn: (raw: string) => void) => void} onMessage
 *           every bus message, as the JSON string the visage expects
 * @property {(fn: (raw: string) => void) => void} offMessage
 * @property {(kind: string, fn: (data: object) => void) => void} on
 *           the brain's own events (local: status, gui, audio, phal, model, bus)
 * @property {(cmd: string, args?: object, transfer?: Transferable[]) => Promise<any>} [call]
 *           local only: a worker.js command
 * @property {() => void} stop
 */

import { createLocalBrain } from "./local.js";

export const BRAINS = ["local"];   // "hivemind", "homeassistant" when they exist
const KEY = "emkay-brain";

/**
 * Which brain this start uses: ?brain=… for this start, else the saved
 * choice, else local. A brain that doesn't exist yet falls back to local.
 * @param {URLSearchParams} params
 */
export function chosenBrain(params) {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  const want = params.get("brain") || saved || "local";
  if (BRAINS.includes(want)) return want;
  console.warn(`[emkay] brain "${want}" isn't there yet; using local`);
  return "local";
}

/** @param {string} kind @returns {Brain} */
export function createBrain(kind) {
  switch (kind) {
    case "local": return createLocalBrain();
  }
  throw new Error(`no brain "${kind}"`);
}
