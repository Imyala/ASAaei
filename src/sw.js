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
const MANIFEST = self.__WB_MANIFEST
precache(MANIFEST)

// The page this worker serves for every navigation is fetched HERE, at
// install, at a URL that carries this build's own revision of index.html.
// Workbox's precache asks for plain "index.html", and for up to ten minutes
// after a deploy the GitHub Pages CDN answers that with the PREVIOUS page —
// which names a script the deploy just deleted. A worker that precached that
// would serve a blank screen on every device for as long as it lived. A URL
// no cache has seen goes through to the origin, and the page that comes back
// must name a script in this worker's own list, or the install fails and the
// browser simply tries the update again on a later visit while the previous
// worker keeps serving the previous, consistent build.
const SHELL_CACHE = 'asaaei-shell-v1'
const SHELL_KEY = 'shell'
const shellEntry = MANIFEST.find((e) => e.url === 'index.html' || e.url.endsWith('/index.html'))
const ownAssets = new Set(MANIFEST.map((e) => new URL(e.url, self.location.href).pathname))
self.addEventListener('install', (event) => {
  if (!shellEntry) return
  event.waitUntil((async () => {
    const url = new URL(shellEntry.url, self.location.href)
    url.searchParams.set('build', shellEntry.revision || 'x')
    const res = await fetch(url.href, { cache: 'reload', credentials: 'same-origin' })
    if (!res.ok) throw new Error(`shell: HTTP ${res.status}`)
    const html = await res.clone().text()
    const src = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1]
    if (!src || !ownAssets.has(new URL(src, url.href).pathname)) {
      throw new Error('shell: the page served is not this build')
    }
    const cache = await caches.open(SHELL_CACHE)
    await cache.put(SHELL_KEY, res)
  })())
})

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
  // A navigation gets THIS worker's own copy of the page, whatever the query
  // string says. The page and the worker are one build, so the page always
  // names assets this worker has; going to the network instead could hand
  // back a stale copy from a CDN that names assets already deleted — a blank
  // screen — or silently flip the app to a different build than the worker's.
  // The worker itself updates through the browser's own sw.js check.
  if (req.mode === 'navigate') {
    const own = await (await caches.open(SHELL_CACHE)).match(SHELL_KEY).catch(() => null)
    const shell = own || await matchPrecache('index.html')
    if (shell) return withIsolation(shell)
  }
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
