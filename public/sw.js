// Service worker: makes the viewer load instantly on repeat visits and work on
// flaky / no connection. Bump CACHE_VERSION whenever the app shell files change
// so clients pick up the new UI.
const CACHE_VERSION = "v2";
const SHELL_CACHE = `sd-shell-${CACHE_VERSION}`;
const DECK_CACHE = `sd-deck-${CACHE_VERSION}`;

// Everything needed to render the UI offline (the PDF itself is cached on first use).
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/vendor/pdf.min.mjs",
  "/vendor/pdf.worker.min.mjs",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("sd-") && k !== SHELL_CACHE && k !== DECK_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

// The PDF: serve the cached copy immediately (instant + offline-proof), then check the
// network in the background. If the deck changed (new ETag), cache it and tell the page.
async function deckStrategy(event) {
  const cache = await caches.open(DECK_CACHE);
  const cached = await cache.match("/deck");

  // `cache: "reload"` bypasses the browser HTTP cache so we truly re-check the origin
  // (otherwise the function's max-age would mask a freshly uploaded deck).
  const revalidate = fetch("/deck", { cache: "reload" })
    .then(async (res) => {
      if (res && res.ok) {
        const newEtag = res.headers.get("ETag");
        const oldEtag = cached && cached.headers.get("ETag");
        await cache.put("/deck", res.clone());
        if (cached && newEtag && oldEtag && newEtag !== oldEtag) {
          await notifyClients({ type: "deck-updated" });
        }
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(revalidate); // keep SW alive while it updates in the background
    return cached;
  }
  const fresh = await revalidate;
  return fresh || new Response("Offline and no saved presentation yet.", { status: 503 });
}

// Shell / static assets: serve from cache fast, refresh the cache in the background.
async function staleWhileRevalidate(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request)
    .then((res) => {
      if (res && res.ok) cache.put(event.request, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const res = await network;
  if (res) return res;
  // Offline navigation with nothing cached yet → fall back to the app shell.
  if (event.request.mode === "navigate") {
    return (await cache.match("/index.html")) || Response.error();
  }
  return Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // ignore cross-origin

  if (url.pathname === "/deck") {
    event.respondWith(deckStrategy(event));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});
