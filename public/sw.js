// Offline shell for /m/. Same-origin GETs only; rt.php (live data) is never cached here
// (the app keeps its own last-known copy), the timetable JSON in data/ is cached on first use.
// shortcut: old hashed assets linger until CACHE is bumped.
const CACHE = "madrid-transit-v5";
const BASE = "/m/";
const SHELL = ["", "index.html", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "fonts/selawkl.woff2", "fonts/selawk.woff2", "fonts/selawksb.woff2"].map((f) => BASE + f);

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // Hashed bundle files are only named inside index.html.
      const html = await (await cache.match(BASE + "index.html")).text();
      await cache.addAll([...new Set(html.match(/\/m\/assets\/[^"')\s]+\.(?:js|css)/g) ?? [])]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
  if (url.pathname === BASE + "rt.php") return;
  if (request.mode === "navigate") {
    // Network first; the last good index.html when offline.
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(BASE + "index.html", res.clone()));
          return res;
        })
        .catch(() => caches.match(BASE + "index.html")),
    );
    return;
  }
  if (url.pathname.startsWith(BASE + "data/")) {
    // Timetable: network first (fresh after a redeploy), cached copy when offline.
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }
  e.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
          return res;
        }),
    ),
  );
});
