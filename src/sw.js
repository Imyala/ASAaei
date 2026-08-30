// ---------------------------------------------------------------------------
// Service worker: offline precache + cross-origin isolation
// ---------------------------------------------------------------------------
// Two jobs, and the second is why this is hand-written instead of workbox's
// generated worker:
//
//   1. OFFLINE — precache the built app (the manifest vite-plugin-pwa injects
//      as self.__WB_MANIFEST) and serve it cache-first, so "Add to Home
//      Screen" keeps working with no connection.
//
//   2. ISOLATION — add the two headers that make the page cross-origin
//      isolated to every response this worker serves:
//
//          Cross-Origin-Opener-Policy: same-origin
//          Cross-Origin-Embedder-Policy: require-corp
//
//      The LibreOffice engine that converts Word documents inside the website
//      (src/wasmConverter.js) is a threaded WebAssembly build, and browsers
//      only hand a threaded build its SharedArrayBuffer on an isolated page.
//      A host like GitHub Pages cannot set response headers at all — but a
//      service worker sits between the page and the network, and headers it
//      puts on a response count. index.html reloads once, when needed, so a
//      freshly-installed worker's headers take effect.
//
// Isolation has one cost: every cross-origin subresource must opt in via CORS
// or Cross-Origin-Resource-Policy. The app is self-contained (its only
// cross-origin traffic is CORS fetches — the engine CDN, a converter on
// another machine), so nothing is lost.

import { precache, cleanupOutdatedCaches, getCacheKeyForURL, matchPrecache } from 'workbox-precaching'
import { clientsClaim } from 'workbox-core'

self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precache(self.__WB_MANIFEST)

// COOP/COEP make the page eligible for SharedArrayBuffer; CORP lets this
// site's own files be loaded by its workers under that same policy.
function withIsolation(res) {
  // An opaque response cannot be rewrapped (status 0, unreadable body) — and
  // a reconstructed redirect would break navigation redirect handling.
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res
  const headers = new Headers(res.headers)
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

async function respond(req) {
  // Precached build asset → serve it from the cache, with the headers on.
  const key = getCacheKeyForURL(req.url)
  if (key) {
    const hit = await caches.match(key)
    if (hit) return withIsolation(hit)
  }
  try {
    return withIsolation(await fetch(req))
  } catch (err) {
    // Offline navigation falls back to the precached shell — that is the PWA
    // promise. Anything else offline is a real failure and should look like one.
    if (req.mode === 'navigate') {
      const shell = await matchPrecache('index.html')
      if (shell) return withIsolation(shell)
    }
    throw err
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  // Cross-origin subresource fetches (the engine CDN, a converter machine)
  // pass through untouched: they are CORS requests the page already handles,
  // and rewrapping a 50 MB stream here buys nothing.
  if (new URL(req.url).origin !== self.location.origin && req.mode !== 'navigate') return
  event.respondWith(respond(req))
})
