// Work-order search connector (SAP entry point).
//
// A browser — especially an iPad — cannot talk to SAP directly: there is no SAP
// GUI, and SAP Gateway/BAPI live inside the company network behind auth that a
// public web page can't reach (and CORS would block anyway). So the search box
// calls a thin *middleware* endpoint that runs inside the network and does the
// real SAP lookup server-side, returning a small JSON summary plus a link to the
// work order's document.
//
// Until that endpoint is configured, this module reports "not connected" instead
// of inventing data — the UI then explains what's needed (see docs/ARCHITECTURE.md).

const SETTING_KEY = 'asaaei:workorderApi'

// Where the in-network middleware lives. Set at build time (VITE_WORKORDER_API)
// or at runtime via localStorage so IT can point it at their server without a
// rebuild. Empty string => not connected yet.
export function getWorkOrderApi() {
  try {
    const stored = localStorage.getItem(SETTING_KEY)
    if (stored) return stored
  } catch { /* localStorage may be unavailable */ }
  try {
    return import.meta.env.VITE_WORKORDER_API || ''
  } catch {
    return ''
  }
}

export function setWorkOrderApi(url) {
  try {
    if (url) localStorage.setItem(SETTING_KEY, url)
    else localStorage.removeItem(SETTING_KEY)
  } catch { /* ignore */ }
}

export function isWorkOrderSearchConfigured() {
  return !!getWorkOrderApi()
}

// Look a work order up in SAP through the middleware.
// Resolves to the middleware's JSON, expected to be shaped like:
//   { number, description, plant, status, equipment, documentUrl, documentName }
// Throws Error; a not-configured error carries code === 'NOT_CONFIGURED'.
export async function searchWorkOrder(number) {
  const n = String(number || '').trim()
  if (!n) throw new Error('Enter a work order number.')

  const base = getWorkOrderApi()
  if (!base) {
    const err = new Error('SAP work-order search is not connected yet.')
    err.code = 'NOT_CONFIGURED'
    throw err
  }

  const url = `${base.replace(/\/+$/, '')}/workorders/${encodeURIComponent(n)}`
  let res
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' })
  } catch {
    throw new Error('Could not reach the SAP service. Are you on the company network?')
  }
  if (res.status === 404) throw new Error(`Work order ${n} was not found in SAP.`)
  if (!res.ok) throw new Error(`SAP lookup failed (${res.status}).`)
  return res.json()
}

// Search the Document Centre (SharePoint) for the form that matches a work
// order, via the same middleware. `query` is the work order's `documentQuery`
// ({ documentNumber?, keywords?, systems?, title? }). Resolves to an array of
// results: { documentNumber, title, fileName, url, score }, best match first.
export async function searchDocumentCentre(query) {
  const base = getWorkOrderApi()
  if (!base) {
    const err = new Error('Document Centre search is not connected yet.')
    err.code = 'NOT_CONFIGURED'
    throw err
  }
  const qs = new URLSearchParams()
  for (const k of ['documentNumber', 'keywords', 'systems', 'title']) {
    if (query && query[k]) qs.set(k, query[k])
  }
  const url = `${base.replace(/\/+$/, '')}/documents/search?${qs.toString()}`
  let res
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' })
  } catch {
    throw new Error('Could not reach the Document Centre service.')
  }
  if (!res.ok) throw new Error(`Document Centre search failed (${res.status}).`)
  const data = await res.json()
  const results = Array.isArray(data.results) ? data.results : []
  // Resolve relative proxy URLs against the middleware base.
  return results.map((r) => ({ ...r, url: resolveUrl(base, r.url) }))
}

function resolveUrl(base, u) {
  if (!u) return u
  if (/^https?:/i.test(u)) return u
  return `${base.replace(/\/+$/, '')}${u.startsWith('/') ? '' : '/'}${u}`
}
