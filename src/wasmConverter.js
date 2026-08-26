// ---------------------------------------------------------------------------
// LibreOffice in the browser (WebAssembly)
// ---------------------------------------------------------------------------
// The same engine the converter service runs, compiled to WebAssembly and run
// on the device itself. No server, no install, no account, and once the engine
// is cached it works with no network at all — which is the point: a technician
// in a plant room with a tablet and no signal still opens a Word procedure with
// its layout intact.
//
// WHY IT IS NOT SIMPLY BUNDLED
// The engine is ~237 MB (a 141 MB .wasm plus a 96 MB data file holding its
// fonts and configuration). That cannot live in the repository — git refuses
// any file over 100 MB — so the app loads it from wherever it is hosted, named
// once in Settings. Nothing is downloaded, and none of this code runs, until
// somebody sets that address.
//
// WHAT THE PAGE MUST PROVIDE
// The build uses threads, so it needs SharedArrayBuffer, which browsers only
// expose to a cross-origin-isolated page:
//
//     Cross-Origin-Opener-Policy: same-origin
//     Cross-Origin-Embedder-Policy: require-corp
//
// `npm run serve --isolate` sets both. GitHub Pages cannot set headers at all,
// so the hosted copy of the app cannot use this route — `isolationProblem()`
// says so plainly rather than letting it fail as a mystery.

import { getConverterSettings } from './converter.js'

export class WasmEngineError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WasmEngineError'
  }
}

// The loaded engine, kept for the life of the page: the download and start-up
// are far too expensive to repeat per document.
let engine = null
let loading = null

export const wasmConfigured = () => Boolean(getConverterSettings().wasmUrl)

// Why this page cannot run the engine, or '' when it can.
export function isolationProblem() {
  if (typeof window === 'undefined') return 'not a browser'
  if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated) {
    return 'This page is not cross-origin isolated, so the browser will not let it run the '
      + 'LibreOffice engine. The page has to be served with Cross-Origin-Opener-Policy: '
      + 'same-origin and Cross-Origin-Embedder-Policy: require-corp — "npm run serve '
      + '--isolate" does that. GitHub Pages cannot set headers, so the hosted copy of the '
      + 'app cannot use this route.'
  }
  return ''
}

const withSlash = (u) => (u.endsWith('/') ? u : u + '/')

// Load the engine and prove it works before anything is allowed to depend on
// it. The proof matters: a converter that starts but cannot actually convert is
// worse than none, because the app would report an exact conversion and hand
// back something else. The service-side pool self-tests for the same reason.
async function loadEngine({ onProgress } = {}) {
  const base = withSlash(getConverterSettings().wasmUrl.trim())
  if (!base) throw new WasmEngineError('No engine address is set.')
  const blocked = isolationProblem()
  if (blocked) throw new WasmEngineError(blocked)

  onProgress?.('Loading the LibreOffice engine — this happens once, then it is cached.')

  let mod
  try {
    // Loaded from the address in Settings, not bundled, so the build stays
    // small and the engine can be hosted wherever the site is allowed to.
    mod = await import(/* @vite-ignore */ `${base}browser.js`)
  } catch (err) {
    throw new WasmEngineError(
      `The engine could not be loaded from ${base} (${err.message}). Check the address, and `
      + 'that the files are served with Cross-Origin-Resource-Policy: cross-origin.')
  }
  const { BrowserConverter, createWasmPaths } = mod
  if (typeof BrowserConverter !== 'function' || typeof createWasmPaths !== 'function') {
    throw new WasmEngineError(`What is hosted at ${base} is not the LibreOffice engine.`)
  }

  const converter = new BrowserConverter({
    ...createWasmPaths(base),
    onProgress: (p) => onProgress?.(
      p?.message ? `${p.message}${p.percent ? ` (${Math.round(p.percent)}%)` : ''}`
        : 'Starting the LibreOffice engine…'),
  })
  // Downloading and compiling ~237 MB takes a while the first time — the
  // engine's own docs put start-up around 80 seconds — so the caller gets
  // progress rather than a frozen screen.
  await converter.initialize()
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

// Convert a Word document to PDF on this device.
//
// Throws WasmEngineError when the engine is not usable — the caller treats that
// like any other missing converter, which means the document is refused rather
// than approximated.
export async function convertViaWasm(bytes, filename, { onProgress, signal } = {}) {
  const { converter } = await getWasmEngine({ onProgress })
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
  onProgress?.('Converting with LibreOffice on this device…')

  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out
  try {
    out = await converter.convert(input, { outputFormat: 'pdf' }, filename)
  } catch (err) {
    throw new WasmEngineError(`LibreOffice could not convert this document: ${err.message}`)
  }
  const pdf = out?.data ? new Uint8Array(out.data) : new Uint8Array(out)

  // Never hand back something that is not a PDF. An engine that returns an
  // error page, an empty buffer or a half-written file must read as a failure
  // here, not as a converted document further down.
  if (pdf.length < 1000 || String.fromCharCode(...pdf.subarray(0, 4)) !== '%PDF') {
    throw new WasmEngineError('The engine did not return a PDF.')
  }
  return {
    bytes: pdf,
    engine: 'LibreOffice (WebAssembly, on this device)',
    // The engine carries its own fonts and cannot see the ones installed on
    // this machine, so Verdana, Segoe UI and MS Gothic are substituted here
    // however the device is set up. Saying so every time is the honest thing:
    // it is the same caveat the service reports when a font is missing there.
    missingFonts: [],
  }
}

// Forget the loaded engine so a changed address is picked up.
export function resetWasmEngine() {
  engine = null
  loading = null
}
