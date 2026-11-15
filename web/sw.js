// Emkay Mobile – Service Worker: serves the stock ovos-control-panel.
//
// On a device the panel is a web server on a port. A browser cannot listen
// on a port, so the panel runs inside the worker (py/emkay_mobile/panel.py)
// and this Service Worker is its "network": every request the panel's pages
// make is answered by the panel app itself, through the Emkay page that
// owns the worker:
//
//   panel iframe --fetch--> here --MessageChannel--> app.js --> worker.js
//
// The panel is unchanged. Two things a server on its own port never needs
// are done here:
//   * Its pages use absolute paths ("/controls", "/static/app.js",
//     location.href = "/login"). The site may live below a path (GitHub
//     Pages: /emkay-mobile/), so links and redirects in what it sends get
//     the panel's prefix (./panel/), and requests under that prefix get it
//     removed again. fetch()es to its root paths (/api/, /static/) come
//     here anyway, since the iframe is one of this worker's pages.
//   * Its cross-site check reads Sec-Fetch-Site, which a Service Worker
//     cannot pass on. It is set here from where the request really came
//     from: "same-origin" only for this site's own pages, otherwise
//     "cross-site", which the panel refuses for anything that writes.
//   * It forbids every frame (X-Frame-Options: DENY, frame-ancestors
//     'none') against clickjacking by other sites. Emkay shows it in a frame
//     over the face, because leaving the page would stop OVOS, so this one
//     site may frame it (SAMEORIGIN, 'self'); other sites still may not.

const PREFIX = new URL("./panel/", self.registration.scope).pathname;
/** The panel's own absolute paths, outside the prefix. */
const ROOTS = ["/api/", "/static/", "/login", "/healthz"];
/** How long a request may wait for the Emkay page (OVOS may be busy). */
const TIMEOUT_MS = 60000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** The panel's path for a request URL, or null if it is not the panel's. */
function panelPath(url) {
  if (url.origin !== self.location.origin) return null;
  if (url.pathname.startsWith(PREFIX)) return "/" + url.pathname.slice(PREFIX.length);
  if (ROOTS.some((r) => url.pathname.startsWith(r) || url.pathname === r.replace(/\/$/, ""))) {
    return url.pathname;
  }
  return null;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const path = panelPath(url);
  if (path !== null) event.respondWith(serve(event, path, url));
});

/** True when the request came from one of this site's own pages. */
async function fromThisSite(event) {
  const req = event.request;
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) return new URL(client.url).origin === self.location.origin;
  }
  // a navigation has no client yet: go by the page it came from
  try {
    return new URL(req.referrer).origin === self.location.origin;
  } catch {
    return false;
  }
}

/** The top-level Emkay page that owns the worker (not a panel frame). */
async function emkayPage() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => !new URL(c.url).pathname.startsWith(PREFIX) && c.frameType === "top-level")
    || all.find((c) => !new URL(c.url).pathname.startsWith(PREFIX));
}

/** Answer one panel request through the Emkay page's worker. */
async function serve(event, path, url) {
  const req = event.request;
  const page = await emkayPage();
  if (!page) {
    return new Response("Open Emkay first: the settings live inside it.", {
      status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const headers = [];
  for (const [k, v] of req.headers) {
    if (!["origin", "referer", "sec-fetch-site"].includes(k)) headers.push([k, v]);
  }
  headers.push(["sec-fetch-site", (await fromThisSite(event)) ? "same-origin" : "cross-site"]);
  const body = ["GET", "HEAD"].includes(req.method) ? null : await req.arrayBuffer();

  const reply = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
    page.postMessage({ panelRequest: {
      method: req.method, path, query: url.search.slice(1), headers, body,
    } }, [channel.port2, ...(body ? [body] : [])]);
  });
  if (!reply) return new Response("Emkay did not answer in time.", { status: 504 });
  return toResponse(reply);
}

/** The panel's answer as a Response, with its absolute paths prefixed. */
function toResponse({ status, headers, body }) {
  const out = new Headers();
  let type = "";
  for (const [k, v] of headers) {
    const name = k.toLowerCase();
    if (name === "content-length") continue;   // the body may be rewritten
    if (name === "location" && v.startsWith("/") && !v.startsWith("//")) {
      out.append(k, PREFIX + v.slice(1));
      continue;
    }
    if (name === "content-type") type = v;
    if (name === "x-frame-options") { out.append(k, "SAMEORIGIN"); continue; }
    if (name === "content-security-policy") {
      out.append(k, v.replace(/frame-ancestors\s+'none'/, "frame-ancestors 'self'"));
      continue;
    }
    out.append(k, v);
  }
  let data = body;
  if (/text\/html|javascript/.test(type) && PREFIX !== "/") {
    data = prefixPaths(new TextDecoder().decode(body), type.includes("html"));
  }
  const nullBody = [101, 204, 205, 304].includes(status);
  return new Response(nullBody ? null : data, { status, headers: out });
}

/**
 * Put the panel's prefix on the absolute paths its pages navigate to:
 * href/src/action="/..." and location.href = "/...". Plain fetch("/api/...")
 * needs nothing (it comes here either way) but is harmless to prefix too.
 */
function prefixPaths(text, html) {
  const out = text
    .replace(/\b(href|src|action)="\/(?!\/)/g, `$1="${PREFIX}`)
    .replace(/(location\.href\s*=\s*["'`])\/(?!\/)/g, `$1${PREFIX}`);
  return html ? out.replace(/<\/head>/i, `${LINK_FIX}${THEME}</head>`) : out;
}

/**
 * The panel also builds links in JavaScript (its menu). This, added to each
 * of its pages (its CSP allows inline scripts), puts the prefix on a
 * root-absolute link just before the browser follows it.
 */
const LINK_FIX = `<script>/* emkay-mobile: keep links inside ${PREFIX} (see sw.js) */
addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  const h = a && a.getAttribute("href");
  if (h && h[0] === "/" && h[1] !== "/" && !h.startsWith(${JSON.stringify(PREFIX)})) {
    a.setAttribute("href", ${JSON.stringify(PREFIX)} + h.slice(1));
  }
}, true);
</script>`;

/**
 * Emkay's look for the panel: its own colour tokens (app.css custom
 * properties) set to Emkay's dark palette and blue accent, the same as the
 * face (visage.css) and the boot screen. Only the values change; the
 * panel's CSS is untouched. "html:root:not([data-emkay])" outranks both of
 * the panel's dark-mode rules, so Emkay's palette holds in every mode.
 */
const THEME = `<style id="emkay-theme">
html:root:not([data-emkay]) {
  color-scheme: dark;
  --bg: #05070a; --bg-soft: #000000; --card: #141b24; --card-soft: #1d232b;
  --bevel: rgba(255, 255, 255, 0.05); --ink: #ffffff; --muted: #8a96a8; --line: #232c38;
  --accent: #22a7f0; --accent-strong: #1478c8; --accent-hover: #0f6ab3;
  --accent-ink: #ffffff; --accent-wash: rgba(34, 167, 240, 0.15);
  --ok: #3ddc84; --warn: #ffc93c; --bad: #ff5c5c;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 12px 34px rgba(0, 0, 0, 0.45);
  --radius: 16px;
}
</style>`;
