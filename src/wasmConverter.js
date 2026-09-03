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
//
// WHAT THE ENGINE CANNOT BE GIVEN, AND WHEN IT CANNOT BE TRUSTED
// Two faults in this engine build, both measured in headless Chromium against
// hand-built one-picture documents (the numbers are in src/docxPreflight.js
// and the README):
//
//  1. It deadlocks, every time, on the pictures a Word document normally
//     carries — PNG, JPEG and EMF alike, body or header — because it never
//     returns from decoding them on demand. A BMP it reads eagerly, and that
//     converts. So every document is pre-flighted (src/docxPreflight.js): the
//     browser re-encodes its pictures as BMPs, losslessly and with their
//     transparency, before the engine sees them; the vector drawings no
//     browser can rasterise are blanked and reported.
//
//  2. The FIRST conversion a freshly started engine performs stops responding
//     at random — silently, inside lok_documentLoad or lok_documentSaveAs —
//     about one time in four on a text-only document and one time in two on
//     a document with a picture. Every conversion after a successful first one
//     completed (22 of 22 in testing, each in two seconds), whatever it
//     contained. So no engine is handed a real document until it has proven
//     itself on a tiny built-in one: the self-test converts in a second or
//     two, and an engine that stalls on it is terminated and started again.
//     The real conversion is still watched, and restarted once if it stalls,
//     before the app gives up and says so.
//
// A stuck engine used to stay stuck for ever: the wrapper's own shutdown asks
// the worker politely, and a worker deep in a synchronous LibreOffice call
// never answers. Stopping an engine here terminates its worker outright.

import JSZip from 'jszip'
import { getConverterSettings } from './converter.js'
import { prepareDocxForEngine } from './docxPreflight.js'

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

// How long the engine may sit on one reported step before the conversion is
// declared stuck and stopped. Generous on purpose: an image-heavy procedure
// on a modest tablet can legitimately spend minutes in "Saving" — slow is
// fine, silent for ever is not. The opening screen warns well before this.
export const STALL_LIMIT_MS = 6 * 60_000

// A real conversion gets two attempts: the first is restarted if it sits on
// one step this long, the second runs to STALL_LIMIT_MS. (A proven engine has
// not stalled on a real document in testing; this is the safety net.)
export const FIRST_ATTEMPT_STALL_MS = 2 * 60_000

// The self-test document converts in one or two seconds on a desktop; a slow
// tablet on a cold font cache may need ten. An engine that reports no step
// for this long during it is stuck — and every second of the limit is a
// second the user waits when it is, so it is per step, not for the whole.
export const SELF_TEST_STALL_MS = 20_000

// Starting the engine (compiling 147 MB of WebAssembly) can take a minute on
// a tablet; an engine that has not come up in this long is not coming up.
export const START_STALL_MS = 3 * 60_000

// How many fresh engines to start before concluding the device cannot run one.
export const SELF_TEST_ATTEMPTS = 5

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

  const startConverter = () => new WorkerBrowserConverter({
    // Everything becomes a same-origin blob: URL — see the header comment.
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

  // Start the engine and make it prove itself — see fault 2 in the header
  // comment. An engine that stalls starting up or on the self-test document
  // is terminated and a fresh one started, up to SELF_TEST_ATTEMPTS times.
  let lastStall = ''
  for (let attempt = 1; attempt <= SELF_TEST_ATTEMPTS; attempt++) {
    emit(attempt === 1
      ? 'Starting LibreOffice — compiling the engine. The first start is the slow one.'
      : `Restarting the engine — attempt ${attempt} of ${SELF_TEST_ATTEMPTS}…`)
    const converter = startConverter()
    try {
      await withStallLimit(converter.initialize(), START_STALL_MS, signal)
      emit('Checking the engine with a test document…')
      // Every progress call from the engine counts as a sign of life; the
      // limit is measured from the last one.
      let lastStepAt = Date.now()
      const downstream = progressSink.report
      progressSink.report = (m, f) => { lastStepAt = Date.now(); downstream?.(m, f) }
      let out
      try {
        out = await withStallLimit(
          converter.convert(await selfTestDocx(), { outputFormat: 'pdf' }, 'self-test.docx'),
          SELF_TEST_STALL_MS, signal, undefined, () => lastStepAt)
      } finally {
        progressSink.report = downstream
      }
      const pdf = out?.data ? new Uint8Array(out.data) : new Uint8Array(out)
      if (!looksLikePdf(pdf)) throw new WasmEngineError('The engine did not return a PDF for the test document.')
      // The data file has been read into the engine's filesystem; its ~100 MB
      // blob has no further reader, so give the memory back. The wasm and
      // script blobs stay — the engine spawns threads later that load them.
      URL.revokeObjectURL(dataUrl)
      return { converter }
    } catch (err) {
      killConverter(converter)
      if (err?.name === 'AbortError') throw err
      if (!(err instanceof EngineStalled)) throw err
      lastStall = err.message
      console.warn(`[asaaei] LibreOffice engine attempt ${attempt}: ${err.message}`)
    }
  }
  throw new WasmEngineError(
    `LibreOffice stopped responding on ${SELF_TEST_ATTEMPTS} starts in a row (${lastStall}). `
    + 'This engine build does that at random on a fresh start, but not usually this often — '
    + 'the device may be short of memory. Reload the page and try again, or open the document '
    + 'another way: the converter service, or a PDF saved from Word.')
}

// Thrown when the engine has gone quiet for longer than a stage is allowed.
export class EngineStalled extends WasmEngineError {
  constructor(message) {
    super(message)
    this.name = 'EngineStalled'
  }
}

// Settle `promise`, or reject with EngineStalled once `ms` have passed with
// no sign of life — and reject with AbortError the moment `signal` fires. A
// terminated worker never settles the wrapper's promise, so every wait on the
// engine goes through here. With `lastActivity` (a function returning the
// time of the engine's last progress report) the limit is measured from that
// moment, so a slow-but-talking engine is not cut off; without it, from now.
export function withStallLimit(promise, ms, signal, describe = () => `no response for ${Math.round(ms / 1000)} s`, lastActivity = null) {
  return new Promise((resolve, reject) => {
    let timer = null
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('cancelled', 'AbortError')) }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (fn) => (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v) }
    const started = Date.now()
    const check = () => {
      const quietFor = Date.now() - (lastActivity ? Math.max(lastActivity(), started) : started)
      if (quietFor >= ms) { done(reject)(new EngineStalled(describe())); return }
      timer = setTimeout(check, Math.min(ms - quietFor + 5, 1000))
    }
    timer = setTimeout(check, ms)
    promise.then(done(resolve), done(reject))
  })
}

// The %PDF magic, and enough bytes behind it to be a document rather than an
// error page or a half-written file.
const looksLikePdf = (bytes) =>
  bytes.length >= 1000 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46

// The self-test document: the smallest .docx that exercises a real load and
// a real PDF export. Text only — a text-only warm-up was enough to make the
// picture documents that followed it convert 22 times out of 22, and it
// stalls less often itself. Built once, kept for the page.
let selfTestBytes = null
export async function selfTestDocx() {
  if (selfTestBytes) return selfTestBytes
  const zip = new JSZip()
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>')
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>')
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>ASAaei engine self-test.</w:t></w:r></w:p>'
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>')
  selfTestBytes = await zip.generateAsync({ type: 'uint8array' })
  return selfTestBytes
}

// Stop an engine for good. The wrapper's destroy() first ASKS its worker to
// shut down and only then terminates it; a worker stuck inside a synchronous
// LibreOffice call never answers, so that request would wait for ever and
// the stuck engine would keep a CPU core busy behind the next one. Terminate
// the worker outright, then let destroy() tidy up what is left.
function killConverter(converter) {
  if (!converter) return
  try { converter.worker?.terminate?.() } catch { /* already gone */ }
  try { converter.worker = null } catch { /* not ours to touch */ }
  try { Promise.resolve(converter.destroy?.()).catch(() => {}) } catch { /* already gone */ }
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
  // Progress is (message, fraction, elapsedMs). The last known fraction is
  // repeated when a stage carries none, so the bar never jumps backwards; the
  // elapsed clock starts here, so it covers the download and start-up too.
  // The visible ticking counter lives in the UI on its own timer — it keeps
  // counting even while LibreOffice is deep in a silent layout stretch.
  const started = Date.now()
  let lastFraction = null
  // The step the engine last reported and when it first reported it: the
  // stall watchdog below rests on this — slow is fine, stuck is not.
  let lastMessage = ''
  let lastStepAt = Date.now()
  const report = (message, fraction = null) => {
    if (Number.isFinite(fraction)) lastFraction = fraction
    if (message !== lastMessage) { lastMessage = message; lastStepAt = Date.now() }
    onProgress?.(message, Number.isFinite(fraction) ? fraction : lastFraction, Date.now() - started)
  }
  progressSink.report = report

  // Pre-flight: re-encode the pictures the engine would hang on (see the
  // header comment and src/docxPreflight.js). A document with no pictures
  // passes through untouched; anything that is not a .docx package (a legacy
  // .doc) does too. If the rewrite itself fails, the original goes in — the
  // watchdog below still bounds the worst case.
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let prepared = { bytes: input, notes: [] }
  try {
    prepared = await prepareDocxForEngine(input, { onProgress: (m) => report(m), signal })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    console.warn('Could not prepare the document for the in-page engine; converting it as-is:', err)
  }
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
  if (prepared.rewritten || prepared.blank) {
    // One line per document, for anyone reading the console next to a report.
    console.info(`[asaaei] pictures prepared for the in-page engine: ${prepared.rewritten} re-encoded, `
      + `${prepared.blank} left blank`)
  }
  // Two attempts (see FIRST_ATTEMPT_STALL_MS): a stalled engine is torn down
  // and a fresh, self-tested one takes over with the same bytes.
  const limits = [FIRST_ATTEMPT_STALL_MS, STALL_LIMIT_MS]
  let out = null
  for (let attempt = 0; attempt < limits.length; attempt++) {
    const { converter } = await getWasmEngine({ onProgress: report, signal })
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    report('Converting with LibreOffice in this browser…', 0)
    lastStepAt = Date.now()

    // Cancel must actually stop the grind: tearing the engine down (its
    // worker is terminated) is the only way to interrupt LibreOffice
    // mid-layout, and the next document simply starts a fresh engine.
    const cancelNow = () => resetWasmEngine()
    signal?.addEventListener('abort', cancelNow, { once: true })
    // A terminated worker never settles the wrapper's promise, so the
    // conversion is raced against Cancel and against the stall watchdog, and
    // both settle it themselves.
    let watchdog = null
    const limit = limits[attempt]
    const stopped = new Promise((_, reject) => {
      watchdog = setInterval(() => {
        if (signal?.aborted) { reject(new DOMException('cancelled', 'AbortError')); return }
        const stuckFor = Date.now() - lastStepAt
        if (stuckFor < limit) return
        resetWasmEngine()
        reject(new EngineStalled(
          `no progress for ${Math.round(stuckFor / 60000)} minutes at "${lastMessage || 'converting'}"`))
      }, 2000)
    })
    try {
      out = await Promise.race([
        converter.convert(prepared.bytes, { outputFormat: 'pdf' }, filename),
        stopped,
      ])
      break
    } catch (err) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      if (err instanceof EngineStalled && attempt < limits.length - 1) {
        console.warn(`[asaaei] LibreOffice stopped responding (${err.message}); restarting the engine and trying again`)
        report(`LibreOffice stopped responding (${err.message}). Restarting the engine and trying again…`)
        continue
      }
      if (err instanceof EngineStalled) {
        throw new WasmEngineError(
          `LibreOffice stopped responding twice on this document (${err.message}), so the conversion `
          + 'was stopped. The document uses something this engine build cannot handle. Open it another '
          + 'way: the converter service converts every document in seconds, and a PDF saved from Word '
          + '(File → Save as → PDF) opens directly with nothing to install.')
      }
      if (err instanceof WasmEngineError) throw err
      throw new WasmEngineError(`LibreOffice could not convert this document: ${err.message}`)
    } finally {
      clearInterval(watchdog)
      signal?.removeEventListener('abort', cancelNow)
    }
  }
  const pdf = out?.data ? new Uint8Array(out.data) : new Uint8Array(out)

  // Never hand back something that is not a PDF. An engine that returns an
  // error page, an empty buffer or a half-written file must read as a failure
  // here, not as a converted document further down.
  if (!looksLikePdf(pdf)) throw new WasmEngineError('The engine did not return a PDF.')
  return {
    bytes: pdf,
    engine: 'LibreOffice (in this browser)',
    // The engine carries its own fonts and cannot see the ones installed on
    // this machine, so Verdana, Segoe UI and MS Gothic are substituted here
    // however the device is set up. Saying so every time is the honest thing:
    // it is the same caveat the service reports when a font is missing there.
    missingFonts: [],
    // What the pre-flight had to leave blank (EMF/WMF drawings), for the
    // banner above the document. Empty when every picture came through.
    graphicNotes: prepared.notes || [],
  }
}

// Forget the loaded engine so a changed source is picked up.
export function resetWasmEngine() {
  const old = engine
  engine = null
  loading = null
  killConverter(old?.converter)
}
