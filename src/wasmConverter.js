// ---------------------------------------------------------------------------
// LibreOffice inside the website (WebAssembly)
// ---------------------------------------------------------------------------
// The same engine the converter service runs, compiled to WebAssembly and run
// in the browser itself. No server, no install, no account — and once the
// engine is cached it works with no network at all. It is ON by default: the
// app carries the small wrapper (public/libreoffice/, MPL-2.0) and fetches the
// engine binaries from a free public CDN the first time they are needed.
//
// WHERE THE ENGINE COMES FROM
// The engine is ~247 MB uncompressed (a 147 MB .wasm plus a 100 MB data file
// holding its fonts and configuration), which is past what this repository can
// hold (git refuses files over 100 MB) and past what free CDNs will serve as
// single files (jsDelivr stops at 50 MB). The answer is the build published as
// @bentopdf/libreoffice-wasm on npm — the identical engine with the two big
// files gzipped, every file under the CDN limit — which the app downloads
// (~78 MB), decompresses with the browser's own DecompressionStream, and keeps
// in the Cache API so the download happens once, not per document. A
// self-hosted copy can be named in Settings instead, for a network that cannot
// reach the CDN; both compressed and uncompressed layouts are accepted.
//
// WHY EVERYTHING BECOMES A blob: URL
// Workers can only be created same-origin, and the engine spawns several (it
// is a threaded build). Fetching each file ourselves and handing the engine
// blob: URLs makes every piece same-origin regardless of where it was
// downloaded from — and is also what lets the compressed files be served from
// a CDN that has no idea it is hosting an office suite.
//
// WHAT THE PAGE MUST PROVIDE
// The build uses threads, so it needs SharedArrayBuffer, which browsers only
// expose to a cross-origin-isolated page:
//
//     Cross-Origin-Opener-Policy: same-origin
//     Cross-Origin-Embedder-Policy: require-corp
//
// `npm run serve` and the dev server send both. On a host that cannot set
// headers at all (GitHub Pages), the app's service worker injects them and
// index.html reloads the page once so they take effect — see src/sw.js.

import { getConverterSettings } from './converter.js'

export class WasmEngineError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WasmEngineError'
  }
}

// The engine build used when no self-hosted address is set in Settings.
// Version-pinned so a converted document is reproducible: a "latest" tag could
// change the engine — and therefore the layout — under a controlled document.
// This is the build BentoPDF publishes for exactly this purpose (LibreOffice
// via @matbee/libreoffice-converter, MPL-2.0), served by jsDelivr, a free CDN
// for public npm packages.
export const DEFAULT_ENGINE_ASSETS =
  'https://cdn.jsdelivr.net/npm/@bentopdf/libreoffice-wasm@2.3.1/assets/'

// Where the engine's downloaded files live between visits. Bump the suffix if
// the storage format ever changes shape.
const ENGINE_CACHE = 'asaaei-libreoffice-engine-v1'

// The wrapper that drives the engine (dist/browser.js of
// @matbee/libreoffice-converter, vendored in public/libreoffice/ with its
// worker bundle). Served with the app itself: same origin, precached by the
// service worker, no CDN involved.
const wrapperUrl = (file) =>
  new URL(`libreoffice/${file}`, document.baseURI).href

// The loaded engine, kept for the life of the page: the download and start-up
// are far too expensive to repeat per document.
let engine = null
let loading = null

// Progress travels as (message, fraction) with fraction in [0,1] or null when
// this stretch has no honest number. The engine outlives any one conversion,
// so its progress callback goes through this mutable sink — otherwise the
// second document's progress would still be delivered to the first caller.
const progressSink = { report: null }
const emit = (message, fraction = null) => progressSink.report?.(message, fraction)

// The engine is on unless the user has switched it off in Settings. There is
// no address to configure any more — the default source is built in.
export const deviceEngineEnabled = () => getConverterSettings().deviceEngine !== 'off'

// True when the engine route can actually be attempted on this page: switched
// on, and the page is (or can become) cross-origin isolated.
export const wasmAvailable = () => deviceEngineEnabled() && !isolationProblem()

// Why this page cannot run the engine, or '' when it can.
export function isolationProblem() {
  if (typeof window === 'undefined') return 'not a browser'
  if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
    return 'This page is not cross-origin isolated, so the browser will not let it run the '
      + 'LibreOffice engine. Served over https (or from "npm run serve") the app arranges '
      + 'this by itself — reload the page once if it has just been installed. A page on '
      + 'plain http from another machine cannot be isolated by any setting: browsers only '
      + 'allow it in a secure context.'
  }
  if (typeof DecompressionStream === 'undefined') {
    return 'This browser is too old to unpack the engine (it has no DecompressionStream). '
      + 'Update the browser, or use the converter service instead.'
  }
  return ''
}

// Where the engine files are fetched from: the address in Settings, or the
// built-in CDN source. Exported for the Settings screen.
export function engineAssetsBase() {
  const url = (getConverterSettings().wasmUrl || '').trim() || DEFAULT_ENGINE_ASSETS
  return url.endsWith('/') ? url : `${url}/`
}

// ---- fetching the engine ---------------------------------------------------

// The two big files exist gzipped on the CDN (that is what fits them under the
// per-file limit) and plain on a self-hosted mirror of the raw build, so both
// names are tried. Detection is by content, not by name — see isGzip.
export function candidateNames(name) {
  return /\.(wasm|data)$/.test(name) ? [`${name}.gz`, name] : [name]
}

// Gzip's magic bytes. The decision to decompress is made from the bytes
// themselves so a server that transparently decompressed (or one serving
// plain files under a .gz name) still works.
export const isGzip = (bytes) =>
  bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('gzip'))
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

const MB = (n) => `${Math.round(n / 1048576)} MB`

// Fetch one engine file: Cache API first, network second, and the compressed
// bytes are what gets cached — the engine is ~78 MB compressed and ~247 MB
// unpacked, and quota is the scarcer thing. Returns decompressed bytes.
async function fetchEngineFile(base, name, { onProgress, signal } = {}) {
  const cache = await openEngineCache()
  let lastErr = null
  for (const candidate of candidateNames(name)) {
    const url = `${base}${candidate}`
    try {
      let res = cache && await cache.match(url)
      const fromCache = Boolean(res)
      if (!res) {
        res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' })
        if (!res.ok) { lastErr = new Error(`${url}: HTTP ${res.status}`); continue }
      }
      // Throttle to whole megabytes: reporting every network chunk would
      // re-render the progress screen thousands of times per file.
      let lastMb = -1
      const bytes = await readWithProgress(res, (done, total) => {
        const mb = done >> 20
        if (mb === lastMb) return
        lastMb = mb
        onProgress?.(fromCache
          ? `Preparing the LibreOffice engine (${name})…`
          : `Downloading the LibreOffice engine — ${name}, ${MB(done)}${total ? ` of ${MB(total)}` : ''}. `
            + 'This happens once; afterwards it is kept on this device.',
        total ? done / total : null)
      }, signal)
      if (!fromCache && cache) {
        // Cache AFTER the body arrived intact, keyed by the real URL so a
        // version bump in the address naturally misses and re-downloads.
        try { await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })) } catch { /* quota — still works, just not offline */ }
      }
      return isGzip(bytes) ? await gunzip(bytes) : bytes
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      lastErr = err
    }
  }
  throw new WasmEngineError(
    `The engine file ${name} could not be fetched from ${base} `
    + `(${lastErr?.message || 'no candidate answered'}). If this device cannot reach the `
    + 'CDN, host the engine files yourself and set the address in Settings.')
}

// Cache API access that degrades to "no cache" instead of failing the load —
// private browsing on some browsers throws on caches.open().
async function openEngineCache() {
  try { return await caches.open(ENGINE_CACHE) } catch { return null }
}

// Read a response body while reporting progress, so a 78 MB first-time
// download is a visible, honest wait instead of a frozen screen.
async function readWithProgress(res, report, signal) {
  const total = Number(res.headers.get('Content-Length') || 0)
  if (!res.body?.getReader) {
    report(0, total)
    return new Uint8Array(await res.arrayBuffer())
  }
  const reader = res.body.getReader()
  const chunks = []
  let done = 0
  report(0, total)
  for (;;) {
    if (signal?.aborted) { reader.cancel().catch(() => {}); throw new DOMException('cancelled', 'AbortError') }
    const { value, done: finished } = await reader.read()
    if (finished) break
    chunks.push(value)
    done += value.byteLength
    report(done, total)
  }
  const out = new Uint8Array(done)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}

// Drop cached files that belong to another engine source or version, so
// switching sources doesn't strand ~78 MB of stale bytes in quota.
async function pruneEngineCache(keepUrls) {
  const cache = await openEngineCache()
  if (!cache) return
  const wanted = new Set(keepUrls)
  for (const req of await cache.keys()) {
    if (!wanted.has(req.url)) await cache.delete(req)
  }
}

// ---- starting the engine ---------------------------------------------------

const blobUrl = (bytes, type) => URL.createObjectURL(new Blob([bytes], { type }))

// Load the engine and prove it works before anything is allowed to depend on
// it. The proof matters: a converter that starts but cannot actually convert
// is worse than none, because the app would report an exact conversion and
// hand back something else. The service-side pool self-tests for the same
// reason.
async function loadEngine({ onProgress, signal } = {}) {
  if (onProgress) progressSink.report = onProgress
  const blocked = isolationProblem()
  if (blocked) throw new WasmEngineError(blocked)
  const base = engineAssetsBase()

  // The wrapper travels with the app — it is small, versioned with the code,
  // and works offline. Only the engine binaries come from the CDN.
  let mod
  try {
    mod = await import(/* @vite-ignore */ wrapperUrl('browser.js'))
  } catch (err) {
    throw new WasmEngineError(
      `The LibreOffice wrapper could not be loaded from this site (${err.message}). `
      + 'The deployment is missing public/libreoffice/ — rebuild and redeploy the app.')
  }
  const { WorkerBrowserConverter } = mod
  if (typeof WorkerBrowserConverter !== 'function') {
    throw new WasmEngineError('What is deployed at libreoffice/browser.js is not the LibreOffice wrapper.')
  }

  // Engine files, largest last so an unreachable source fails fast on the
  // small loader script instead of after minutes of download. Each byte
  // buffer is dropped the moment its blob exists: keeping ~250 MB of
  // decompressed engine alive next to the running engine is exactly the
  // memory pressure that pushes a modest laptop into swapping — and a
  // swapping machine reads as "the app froze".
  let bytes = await fetchEngineFile(base, 'soffice.js', { onProgress: emit, signal })
  const jsUrl = blobUrl(bytes, 'text/javascript')
  bytes = await fetchEngineFile(base, 'soffice.worker.js', { onProgress: emit, signal })
  const workerUrl = blobUrl(bytes, 'text/javascript')
  bytes = await fetchEngineFile(base, 'soffice.data', { onProgress: emit, signal })
  const dataUrl = blobUrl(bytes, 'application/octet-stream')
  bytes = await fetchEngineFile(base, 'soffice.wasm', { onProgress: emit, signal })
  const wasmUrl = blobUrl(bytes, 'application/wasm')
  bytes = null
  pruneEngineCache(
    ['soffice.js', 'soffice.worker.js', 'soffice.data', 'soffice.wasm']
      .flatMap((n) => candidateNames(n).map((c) => `${base}${c}`)),
  ).catch(() => {})
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')

  emit('Starting LibreOffice — compiling the engine. The first start is the slow one.')

  // Everything becomes a same-origin blob: URL — see the header comment.
  const converter = new WorkerBrowserConverter({
    sofficeJs: jsUrl,
    sofficeWasm: wasmUrl,
    sofficeData: dataUrl,
    sofficeWorkerJs: workerUrl,
    // The wrapper's own worker: same origin, so its URL is passed straight
    // through. Runs the conversion off the main thread — the page stays
    // responsive while LibreOffice grinds.
    browserWorkerJs: wrapperUrl('browser.worker.global.js'),
    // Delivered through the sink so progress always reaches the CURRENT
    // conversion's screen, not the one that happened to load the engine.
    onProgress: (p) => emit(
      p?.message
        ? `${p.message.replace(/\.\.\.\s*$/, '')}${Number.isFinite(p.percent) && p.percent > 0 ? ` (${Math.round(p.percent)}%)` : '…'}`
        : 'Starting the LibreOffice engine…',
      Number.isFinite(p?.percent) && p.percent > 0 ? p.percent / 100 : null),
  })
  await converter.initialize()
  // The data file has been read into the engine's filesystem; its ~100 MB
  // blob has no further reader, so give the memory back. The wasm and script
  // blobs stay — the engine spawns threads later that load them again.
  URL.revokeObjectURL(dataUrl)
  return { converter }
}

export function getWasmEngine(opts) {
  if (engine) return Promise.resolve(engine)
  if (loading) return loading
  loading = loadEngine(opts)
    .then((e) => { engine = e; return e })
    .finally(() => { loading = null })
  return loading
}

// Convert a Word document to PDF in this browser.
//
// Throws WasmEngineError when the engine is not usable — the caller treats
// that like any other missing converter, which means the document is refused
// rather than approximated.
export async function convertViaWasm(bytes, filename, { onProgress, signal } = {}) {
  // Track the freshest message and fraction so the heartbeat below can repeat
  // the last known position instead of blanking the bar.
  let lastAt = Date.now()
  let lastFraction = null
  const report = (message, fraction = null) => {
    lastAt = Date.now()
    if (Number.isFinite(fraction)) lastFraction = fraction
    onProgress?.(message, Number.isFinite(fraction) ? fraction : lastFraction)
  }
  progressSink.report = report

  const { converter } = await getWasmEngine({ onProgress: report, signal })
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
  report('Converting with LibreOffice in this browser…', 0)

  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out
  // Laying out a long document is one long synchronous grind inside the
  // worker with no callbacks, which read as "stuck at 30%". A heartbeat says
  // it is alive and for how long; and Cancel must actually stop the grind —
  // tearing the engine down (the worker is terminated) is the only way, and
  // the next document simply starts it again.
  const started = Date.now()
  // The count is in ticking seconds ON PURPOSE: a number that visibly climbs
  // every few seconds is the difference between "working on it" and "frozen".
  // If this counter ever stands still, the page itself has stalled — which is
  // a machine-level problem (usually memory), not a quiet conversion.
  const elapsed = () => {
    const s = Math.round((Date.now() - started) / 1000)
    return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
  }
  const heartbeat = setInterval(() => {
    if (Date.now() - lastAt < 6000) return
    onProgress?.(
      `Still converting — ${elapsed()} so far. LibreOffice is working through the document; `
      + 'a long procedure takes a while on this route (the converter service does it in seconds).',
      lastFraction)
  }, 5000)
  const cancelNow = () => resetWasmEngine()
  signal?.addEventListener('abort', cancelNow, { once: true })
  try {
    out = await converter.convert(input, { outputFormat: 'pdf' }, filename)
  } catch (err) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    throw new WasmEngineError(`LibreOffice could not convert this document: ${err.message}`)
  } finally {
    clearInterval(heartbeat)
    signal?.removeEventListener('abort', cancelNow)
  }
  const pdf = out?.data ? new Uint8Array(out.data) : new Uint8Array(out)

  // Never hand back something that is not a PDF. An engine that returns an
  // error page, an empty buffer or a half-written file must read as a failure
  // here, not as a converted document further down.
  if (pdf.length < 1000
      || pdf[0] !== 0x25 || pdf[1] !== 0x50 || pdf[2] !== 0x44 || pdf[3] !== 0x46) {
    throw new WasmEngineError('The engine did not return a PDF.')
  }
  return {
    bytes: pdf,
    engine: 'LibreOffice (in this browser)',
    // The engine carries its own fonts and cannot see the ones installed on
    // this machine, so Verdana, Segoe UI and MS Gothic are substituted here
    // however the device is set up. Saying so every time is the honest thing:
    // it is the same caveat the service reports when a font is missing there.
    missingFonts: [],
  }
}

// Forget the loaded engine so a changed source is picked up.
export function resetWasmEngine() {
  const old = engine
  engine = null
  loading = null
  try { old?.converter?.destroy?.() } catch { /* already gone */ }
}
