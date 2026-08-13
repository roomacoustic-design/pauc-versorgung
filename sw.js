// Offline-first: alles wird beim Install vorgecacht, Fetches kommen aus dem
// Cache (cache-first). Neue Version => VERSION hochzählen.
// Bei jedem neuen Daten- oder Code-Stand hochzählen, sonst liefert der
// Cache alte Bundles aus.
const VERSION = "v3-2026-08-13";
const CACHE = `versorgung-${VERSION}`;
const ASSETS = [
  ".",
  "index.html",
  "style.css",
  "js/main.js",
  "js/logic.js",
  "tour.json",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  // cache:'reload' umgeht den HTTP-Cache — sonst landet beim Update ein
  // veralteter Stand im neuen Cache.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit
      || fetch(e.request).then((res) => {
        // Nur eigene Assets nachcachen, keine Fremd-Requests
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }))
  );
});
