// Language matching, shared by the page (i18n.js) and the worker (worker.js).
// Its own module, without the texts: the worker must not wait for texts.json
// before it listens for the page's first message.

/**
 * The site language for `code`: the one in `langs` (e.g. the languages the
 * site has pre-trained intents for, "da-DK") that is `code` exactly, else
 * the first with the same base language ("da"); null when there is none.
 * The same rule as boot._phone_language.
 */
export function matchLang(code, langs) {
  const c = String(code || "").toLowerCase().replace("_", "-");
  if (!c) return null;
  return langs.find((l) => l.toLowerCase() === c)
    ?? langs.find((l) => l.split("-")[0].toLowerCase() === c.split("-")[0])
    ?? null;
}
