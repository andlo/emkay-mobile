// Emkay's own texts (start screen, menu, boot progress) in the languages
// Emkay ships. Everything OVOS says or shows comes from OVOS itself; these
// are only the few words around it.
//
// The texts live in locale/<lang>/<key>.dialog, the layout and format of an
// OVOS skill's dialogs, so OVOS' translation tooling can read them; the
// build gathers them into texts.json. To add a language, add its folder.
//
// Which language: the phone's (navigator.languages) until OVOS is up, then
// OVOS' own `lang` - which is the phone's language too unless the user chose
// another one in the control panel (boot.py, _phone_language). A language
// without texts here falls back to English.
//
// In index.html an element is translated by data-i18n="key" (its text),
// data-i18n-aria="key" (aria-label) or data-i18n-placeholder="key".

import { matchLang } from "./langs.js";
export { matchLang };

/**
 * {lang: {key: text}}, built from locale/<lang>/<key>.dialog (OVOS' own
 * locale layout, see tools/build_site.py). Empty outside the site (Node).
 */
export const TEXTS = await fetch(new URL("texts.json", import.meta.url))
  .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
TEXTS["en-us"] ??= {};
const LANGS = Object.keys(TEXTS);


/** The text language for a language code ("da-DK", "pt-br", "es-CO" …):
 * the same one, else one with the same base language, else en-us. */
export function pick(code) {
  return matchLang(code, LANGS) || "en-us";
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
  const s = TEXTS[current]?.[key] ?? TEXTS["en-us"][key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translate the marked elements under `root` (see the top of this file). */
export function apply(root = document) {
  root.documentElement && (root.documentElement.lang = current);
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
}
