// ---------------------------------------------------------------------------
// Conversion service client
// ---------------------------------------------------------------------------
// The app has two ways to turn a Word document into a PDF:
//
//   HIGH FIDELITY — hand the file to a LibreOffice converter (see server/).
//     LibreOffice lays the document out with Writer's real engine, so fonts,
//     table geometry, headers/footers and page breaks come out exactly as Word
//     drew them, and the PDF is *vector*: the text stays selectable and the
//     ruled lines stay real lines, which is also what lets the app drop fill
//     boxes precisely inside each cell. A 35-page form takes about 1.5 s.
//
//   IN-BROWSER — mammoth + html2canvas (convert.js).
//     No install, works completely offline, but it rebuilds the document as
//     HTML and photographs it: fonts and spacing are approximated and every
//     page is a flat image.
//
// This module decides which one to use, and does it without asking the user
// anything: on start it quietly probes for a converter, and if it finds one,
// high fidelity is simply on. If it doesn't, the app carries on with the
// in-browser path exactly as before. Nothing here can leave the app unable to
// convert.

const SETTINGS_KEY = 'asaaei:converter'

// Where to look for a converter, in order:
//   1. same origin — `npm run serve` hosts the app and the API together, so a
//      tablet that loads the app has already found the converter;
//   2. the machine the browser is running on, for a desktop that runs the
//      server locally while the app is loaded from somewhere else.
// A URL the user typed is always tried before either.
const AUTO_CANDIDATES = ['', 'http://localhost:8787', 'http://127.0.0.1:8787']

const DEFAULTS = {
  // 'auto'    — use a converter if one can be found, else the browser
  // 'service' — require the converter; report an error rather than degrade
  // 'browser' — never use a converter
  mode: 'auto',
  url: '',
  quality: 'balanced',
  // The LibreOffice engine that runs inside the website (wasmConverter.js).
  // 'on' by default: when no converter service is reachable, the engine that
  // ships with the app is fetched and the document still converts exactly.
  // 'off' restores the old refuse-and-explain behaviour.
  deviceEngine: 'on',
  // Where the engine files are hosted. Empty means the copy bundled with the
  // app, falling back to the pinned CDN build (see engineAssetsBases in
  // wasmConverter.js); set it to force a specific self-hosted copy.
  wasmUrl: '',
}

export const QUALITY_LABELS = {
  fast: 'Smaller file',
  balanced: 'Balanced',
  archive: 'Best quality',
}

export const QUALITY_HELP = {
  fast: 'Images at 150 dpi. Smallest PDF and quickest to open on a tablet.',
  balanced: 'Images at 300 dpi — full print resolution. The right choice for almost everything.',
  archive: 'Images untouched, plus a tagged structure for screen readers. Noticeably larger files.',
}

// ---- settings --------------------------------------------------------------

export function getConverterSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULTS }
    const saved = JSON.parse(raw)
    return { ...DEFAULTS, ...saved }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setConverterSettings(patch) {
  const next = { ...getConverterSettings(), ...patch }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  // The endpoint may have changed, so the next call must re-discover.
  discovered = null
  return next
}

// ---- discovery -------------------------------------------------------------

// The converter we found last, cached for the session. `null` means "not looked
// yet"; an object with `ok: false` means "looked, and there isn't one" — both
// are remembered so we probe once, not on every file the user opens.
let discovered = null
let discovering = null

// Base URL for the same-origin case. An empty candidate means "this origin",
// which is how the bundled `npm run serve` deployment is reached.
const resolveBase = (candidate) =>
  candidate || (typeof location !== 'undefined' ? location.origin : '')

// A page served over https cannot call a plain-http address on the network:
// the browser blocks it as mixed content before the request is made. localhost
// is the exception — browsers treat it as trustworthy — so a converter on this
// same machine is still reachable, subject to the local-network permission
// below. Detecting this up front is what lets the app say *why* it found
// nothing instead of shrugging.
const HTTPS_PAGE = typeof location !== 'undefined' && location.protocol === 'https:'
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i
const isBlockedFromThisPage = (base) =>
  HTTPS_PAGE && /^http:\/\//i.test(base) && !LOOPBACK.test(base)

// Probe one candidate. Returns null when there is nothing there at all, and a
// result object otherwise — including for a converter that answers but cannot
// convert, because "LibreOffice is running but has no Writer filters" is worth
// saying out loud rather than reporting as silence.
async function probe(candidate, timeoutMs = 2500) {
  const base = resolveBase(candidate)
  if (!base) return null
  if (isBlockedFromThisPage(base)) {
    return {
      ok: false,
      base,
      blocked: 'mixed-content',
      reason: `This page is served over https, so the browser will not let it reach ${base}.`,
    }
  }
  try {
    const res = await fetchWithTimeout(`${base}/api/health`, { method: 'GET' }, timeoutMs)
    if (!res.ok) return null
    const info = await res.json()
    // Guard against a host that answers /api/health with something else
    // entirely (a proxy, a different app) — only our server counts.
    if (info.app !== 'asaaei-converter') return null
    if (!info.ok) {
      // Reached it, and it told us it cannot convert. Carry its own reason.
      return {
        ok: false,
        base,
        info,
        reason: info.error
          ? `The converter at ${base} is running, but ${info.error}`
          : `The converter at ${base} is running but is not ready to convert.`,
      }
    }
    return { ok: true, base, info }
  } catch {
    return null
  }
}

// Find a converter. Safe to call repeatedly — the first call does the work and
// the rest share its result.
export function discoverConverter({ force = false } = {}) {
  if (force) { discovered = null; discovering = null }
  if (discovered) return Promise.resolve(discovered)
  if (discovering) return discovering

  discovering = (async () => {
    const settings = getConverterSettings()
    if (settings.mode === 'browser') {
      return { ok: false, reason: 'Set to always convert in the browser.' }
    }

    const candidates = settings.url
      ? [settings.url.replace(/\/+$/, ''), ...AUTO_CANDIDATES]
      : AUTO_CANDIDATES

    // The best answer we got from anything that responded. A converter that is
    // running but broken beats "nothing answered" as an explanation.
    let nearMiss = null
    for (const candidate of candidates) {
      // A URL the user typed deserves longer than an automatic guess: it may be
      // another machine on the office network, a hop or two away.
      const found = await probe(candidate, candidate === settings.url ? 6000 : 2500)
      if (found?.ok) { discovered = found; return found }
      if (found && !nearMiss) nearMiss = found
    }

    discovered = nearMiss ? { ...nearMiss, fix: fixFor(nearMiss) } : {
      ok: false,
      reason: settings.url
        ? `No converter answered at ${settings.url}.`
        : 'No converter is running on this device, or this page cannot reach it.',
      fix: fixFor(null),
    }
    return discovered
  })().finally(() => { discovering = null })

  return discovering
}

// What to actually do about it. Every branch ends with something the person
// reading it can carry out — the old message ("No converter found on this
// device or network.") was true and useless.
function fixFor(nearMiss) {
  if (nearMiss?.blocked === 'mixed-content') {
    return `Open the app from the converter itself — type ${nearMiss.base} into the browser `
      + 'instead of using this address. Served from there, the app and the converter share '
      + 'one address and the browser stops blocking them.'
  }
  if (nearMiss?.info && !nearMiss.info.ok) {
    return 'Fix the converter on the machine running it, then press Check again.'
  }
  if (HTTPS_PAGE) {
    return 'Start it on this machine with "npm run serve", then reload. If the browser asks '
      + 'whether this site may reach devices on your local network, allow it. A converter on '
      + 'another machine cannot be reached from this address at all — open the app from that '
      + "machine's own address (http://its-ip:8787) instead."
  }
  return 'Start it with "npm run serve" on the machine that has LibreOffice, then press Check '
    + 'again. On a tablet, put that machine\'s address in Converter address below.'
}

// What the UI shows without triggering a probe of its own.
export const lastConverterStatus = () => discovered

// ---- conversion ------------------------------------------------------------

export class ConverterUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConverterUnavailableError'
  }
}

// Convert a document to PDF bytes through the service.
//
// Throws ConverterUnavailableError when there is no converter to talk to — the
// caller treats that as "fall back to the browser". Any other error means the
// converter was reached and refused the document (a corrupt file, an
// unsupported type), which is worth showing to the user as-is.
export async function convertViaService(input, filename, { quality, signal } = {}) {
  const settings = getConverterSettings()
  const found = await discoverConverter()
  if (!found.ok) throw new ConverterUnavailableError(found.reason || 'no converter available')

  const body = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  const res = await fetch(`${found.base}/api/convert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(filename || 'document.docx'),
      'X-Quality': quality || settings.quality || 'balanced',
    },
    body,
    signal,
  }).catch((err) => {
    // The user cancelling is not the converter failing. Letting an abort become
    // a ConverterUnavailableError would send the caller down the browser
    // fallback — the app would grind through the very conversion the user just
    // asked it to stop.
    if (err?.name === 'AbortError') throw err
    // The health check passed a moment ago but the request failed, so the
    // server has gone away — re-discover next time rather than staying stuck
    // on a dead endpoint.
    discovered = null
    throw new ConverterUnavailableError(err.message || 'the converter stopped responding')
  })

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    if (res.status === 503) {
      discovered = null
      throw new ConverterUnavailableError(detail.error || 'the converter is not ready')
    }
    throw new Error(detail.error || `the converter returned ${res.status}`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  const missing = res.headers.get('X-Convert-Missing-Fonts') || ''
  return {
    bytes,
    engine: res.headers.get('X-Convert-Engine') || 'LibreOffice',
    ms: Number(res.headers.get('X-Convert-Ms') || 0),
    cached: res.headers.get('X-Convert-Cached') === '1',
    pages: Number(res.headers.get('X-Convert-Pages') || 0),
    missingFonts: missing ? missing.split(',').map((s) => s.trim()).filter(Boolean) : [],
  }
}

// True when the user has said the converter is mandatory. The open path uses
// this to decide whether a missing converter is an error or just a quieter
// conversion.
export const converterRequired = () => getConverterSettings().mode === 'service'

// True only when the user has deliberately chosen the in-browser route. Every
// other setting means a Word document is opened exactly or not at all: an
// approximate rebuild of a controlled document is not a degraded copy of it,
// it is a different document, and nothing should produce one by default.
export const approximationAllowed = () => getConverterSettings().mode === 'browser'

// ---- helper ----------------------------------------------------------------

function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { ...options, signal: ctrl.signal, cache: 'no-store' })
    .finally(() => clearTimeout(timer))
}
