/*
 * Service worker.
 *
 * Chrome and Edge require a registered worker with a fetch handler before they
 * will offer "Install app". This one is deliberately network-only: it caches
 * nothing, because everything this origin serves is derived from private
 * session transcripts and has no business sitting in a browser cache. The only
 * cached bytes are the offline notice below, which is generated here.
 */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          "Agent Console is not running.\n\nStart it with: agent-console\n",
          {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        ),
    ),
  );
});
