// Emkay – which brain was chosen (#27), kept in localStorage. Its own
// module, so brain.js and the brains can all use it without a cycle.

const KEY = "emkay-brain";

/** The saved choice, or null. */
export function savedBrain() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

/** Remember `kind` for the next starts. */
export function setBrain(kind) {
  try { localStorage.setItem(KEY, kind); } catch {}
}
