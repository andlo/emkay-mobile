// Emkay's own texts (start screen, menu, boot progress) in the languages
// Emkay ships. Everything OVOS says or shows comes from OVOS itself; these
// are only the few words around it.
//
// Which language: the phone's (navigator.languages) until OVOS is up, then
// OVOS' own `lang` - which is the phone's language too unless the user chose
// another one in the control panel (boot.py, _phone_language). A language
// without texts here falls back to English.
//
// In index.html an element is translated by data-i18n="key" (its text),
// data-i18n-aria="key" (aria-label) or data-i18n-placeholder="key".

export const TEXTS = {
  en: {
    "boot.loading": "Loading…",
    "boot.python": "Starting Python…",
    "boot.packages": "Fetching Python packages…",
    "boot.ovos": "Fetching OpenVoiceOS…",
    "boot.intents": "Fetching pre-trained intents ({lang})…",
    "boot.m2v": "Fetching language model ({lang})…",
    "boot.unpack": "Unpacking…",
    "boot.start": "Starting OpenVoiceOS…",
    "boot.ready": "Ready",
    "boot.skills": "{n} skills ready",
    "boot.error": "Error: {msg}",
    "start": "Tap to start",
    "start.defaults": "Start with defaults",
    "first.text": "Without setup Emkay runs on the defaults: your phone's language " +
      "(or English) and OpenVoiceOS' public servers for speech. Everything can be " +
      "changed later under ⚙.",
    "first.setup": "Set up",
    "about": "OpenVoiceOS in your browser",
    "source": "source code",
    "mic": "Talk",
    "type": "Type to Emkay…",
    "keyboard": "Type",
    "menu": "Menu",
    "menu.export": "Save setup on the phone",
    "menu.import": "Restore setup from a file",
    "menu.panel": "OpenVoiceOS settings",
    "menu.kiosk": "Full screen",
    "close": "Close",
    "storage.kept": "Kept on the phone",
    "storage.loose": "The browser may clear this – save a copy",
    "export.file": "emkay-settings",
    "export.saved": "Saved as {name}",
    "export.failed": "Could not save: {msg}",
    "import.done": "Restored ({files} files from {date}). Restarting…",
    "import.failed": "Could not restore: {msg}",
    "off": "Turned off – tap to start",
  },
  da: {
    "boot.loading": "Henter…",
    "boot.python": "Starter Python…",
    "boot.packages": "Henter Python-pakker…",
    "boot.ovos": "Henter OpenVoiceOS…",
    "boot.intents": "Henter forudtrænede intents ({lang})…",
    "boot.m2v": "Henter sprogmodel ({lang})…",
    "boot.unpack": "Pakker ud…",
    "boot.start": "Starter OpenVoiceOS…",
    "boot.ready": "Klar",
    "boot.skills": "{n} skills klar",
    "boot.error": "Fejl: {msg}",
    "start": "Tryk for at starte",
    "start.defaults": "Start med standard",
    "first.text": "Uden opsætning kører Emkay med standardindstillinger: telefonens " +
      "sprog (eller engelsk) og OpenVoiceOS' offentlige servere til tale. Alt kan " +
      "ændres senere under ⚙.",
    "first.setup": "Sæt op",
    "about": "OpenVoiceOS i din browser",
    "source": "kildekode",
    "mic": "Tal",
    "type": "Skriv til Emkay…",
    "keyboard": "Skriv",
    "menu": "Menu",
    "menu.export": "Gem opsætning på telefonen",
    "menu.import": "Hent opsætning fra en fil",
    "menu.panel": "OpenVoiceOS-indstillinger",
    "menu.kiosk": "Fuld skærm",
    "close": "Luk",
    "storage.kept": "Gemt varigt på telefonen",
    "storage.loose": "Kan ryddes af browseren – gem en kopi",
    "export.file": "emkay-indstillinger",
    "export.saved": "Gemt som {name}",
    "export.failed": "Kunne ikke gemme: {msg}",
    "import.done": "Hentet ({files} filer fra {date}). Genstarter…",
    "import.failed": "Kunne ikke hente: {msg}",
    "off": "Slukket – tryk for at starte",
  },
};

/** The text language for a language code ("da-DK", "da", "en-us" …). */
export function pick(code) {
  const base = String(code || "").toLowerCase().split(/[-_]/)[0];
  return TEXTS[base] ? base : "en";
}

let current = pick((globalThis.navigator?.languages || [])[0] || globalThis.navigator?.language);
const listeners = new Set();

/** The current text language ("en", "da"). */
export function lang() { return current; }

/** Switch to the texts for `code`; listeners run when it changed. */
export function setLang(code) {
  const next = pick(code);
  if (next === current) return;
  current = next;
  for (const f of listeners) f(current);
}

/** Run `f(lang)` whenever the text language changes. */
export function onLangChange(f) { listeners.add(f); }

/** The text for `key`, with {name} placeholders filled from `vars`. */
export function t(key, vars = {}) {
  const s = TEXTS[current][key] ?? TEXTS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translate the marked elements under `root` (see the top of this file). */
export function apply(root = document) {
  root.documentElement && (root.documentElement.lang = current);
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
}
