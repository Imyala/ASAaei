'use strict'

// ===========================================================================
// ASAaei work-order middleware
// ---------------------------------------------------------------------------
// A browser / iPad running the ASAaei PWA cannot talk to SAP or SharePoint
// directly: those systems live inside the Airservices network behind auth a
// public web page can't present, and CORS would block the calls anyway. This
// small Express service runs INSIDE the network and does the real lookups
// server-side, exposing a tiny JSON contract to the app.
//
// It runs in one of two modes:
//   * MOCK  — self-contained demo data + an on-the-fly generated inspection
//             PDF. No SAP/SharePoint needed. Great for local dev / demos.
//   * REAL  — talks to SAP OData (basic auth) and the SharePoint Document
//             Centre Search REST API (bearer / NTLM). See TODO markers below.
//
// Config comes entirely from environment variables (see .env.example).
// ===========================================================================

const express = require('express')
const cors = require('cors')
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')

// --- Config ----------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'

const SAP_ODATA_URL = process.env.SAP_ODATA_URL || ''
const SAP_USER = process.env.SAP_USER || ''
const SAP_PASS = process.env.SAP_PASS || ''

const SP_BASE_URL =
  process.env.SP_BASE_URL || 'https://orbit.hub.airservicesaustralia.com/sites/DocCentre'
const SP_BEARER = process.env.SP_BEARER || ''

// Mock mode is ON when explicitly requested via MOCK, or whenever we don't
// have enough real config to reach both SAP and SharePoint.
function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v || '').trim())
}
const HAS_SAP = !!(SAP_ODATA_URL && SAP_USER && SAP_PASS)
const HAS_SP = !!(SP_BASE_URL && SP_BEARER)
const MOCK = truthy(process.env.MOCK) || !HAS_SAP || !HAS_SP

// ---------------------------------------------------------------------------
const app = express()

// Permissive CORS for the configured origin. Only GET is used by the app.
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'OPTIONS'],
    credentials: ALLOWED_ORIGIN !== '*',
  })
)

// Build an absolute base URL for THIS service from the incoming request so the
// proxied /documents/fetch links resolve from the browser's point of view.
function selfBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .toString()
    .split(',')[0]
    .trim()
  const host = req.headers['x-forwarded-host'] || req.get('host')
  return `${proto}://${host}`
}

// ===========================================================================
// 1) GET /health
// ===========================================================================
app.get('/health', (req, res) => {
  res.json({ ok: true, mock: MOCK })
})

// ===========================================================================
// 2) GET /workorders/:number
//    -> order header summary + a derived documentQuery describing which
//       Document Centre form to look for.
// ===========================================================================
app.get('/workorders/:number', async (req, res) => {
  const number = String(req.params.number || '').trim()
  if (!number) return res.status(400).json({ error: 'Missing work order number.' })

  if (MOCK) {
    return res.json(mockWorkOrder(number))
  }

  try {
    const order = await fetchSapOrder(number)
    if (!order) return res.status(404).json({ error: `Work order ${number} not found.` })
    return res.json(order)
  } catch (err) {
    console.error('SAP lookup failed:', err)
    return res.status(502).json({ error: 'SAP lookup failed.', detail: String(err.message || err) })
  }
})

// ===========================================================================
// 3) GET /documents/search?documentNumber=&keywords=&systems=&title=
//    -> ranked list of matching Document Centre files. Each result.url points
//       back at THIS service's /documents/fetch proxy.
// ===========================================================================
app.get('/documents/search', async (req, res) => {
  const q = {
    documentNumber: String(req.query.documentNumber || '').trim(),
    keywords: String(req.query.keywords || '').trim(),
    systems: String(req.query.systems || '').trim(),
    title: String(req.query.title || '').trim(),
  }
  const base = selfBase(req)

  if (MOCK) {
    return res.json(mockSearch(q, base))
  }

  try {
    const results = await searchSharePoint(q, base)
    return res.json({ results })
  } catch (err) {
    console.error('SharePoint search failed:', err)
    return res
      .status(502)
      .json({ error: 'Document search failed.', detail: String(err.message || err) })
  }
})

// ===========================================================================
// 4) GET /documents/fetch?src=<url>
//    -> streams the document bytes with correct Content-Type + filename.
// ===========================================================================
app.get('/documents/fetch', async (req, res) => {
  const src = String(req.query.src || '').trim()
  if (!src) return res.status(400).json({ error: 'Missing src.' })

  // Mock document(s): generate an inspection PDF on the fly.
  if (src.startsWith('mock:')) {
    try {
      const bytes = await buildMockInspectionPdf()
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'inline; filename="AppendixB.pdf"')
      return res.end(Buffer.from(bytes))
    } catch (err) {
      console.error('Mock PDF generation failed:', err)
      return res.status(500).json({ error: 'Failed to generate mock PDF.' })
    }
  }

  if (MOCK) {
    // In mock mode we only know how to serve mock: sources.
    return res.status(404).json({ error: 'Unknown mock source.' })
  }

  try {
    await proxySharePointFile(src, res)
  } catch (err) {
    console.error('Document fetch failed:', err)
    if (!res.headersSent) {
      res.status(502).json({ error: 'Document fetch failed.', detail: String(err.message || err) })
    } else {
      res.end()
    }
  }
})

// ===========================================================================
// REAL MODE — SAP
// ===========================================================================

// Fetch a maintenance order header from SAP Gateway (OData) and map it to the
// contract shape. The HTTP + basic-auth + JSON handling here is real and
// runnable; the exact OData entity path/field names are documented placeholders
// that IT must confirm for their SAP release (see TODO markers).
async function fetchSapOrder(number) {
  const authHeader = 'Basic ' + Buffer.from(`${SAP_USER}:${SAP_PASS}`).toString('base64')

  // TODO(IT): Confirm the OData entity set and key that returns the order
  // header. A typical Gateway service exposes something like:
  //   .../ZPM_ORDER_SRV/OrderHeaderSet('2112345')?$format=json
  // If you use a BAPI wrapper (e.g. BAPI_ALM_ORDER_GET_DETAIL surfaced via a
  // custom OData service), point SAP_ODATA_URL at that service root instead.
  const url =
    `${SAP_ODATA_URL.replace(/\/+$/, '')}/OrderHeaderSet('${encodeURIComponent(number)}')` +
    `?$format=json`

  const resp = await fetch(url, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  })

  if (resp.status === 404) return null
  if (!resp.ok) {
    throw new Error(`SAP OData responded ${resp.status}`)
  }

  const json = await resp.json()
  // OData V2 wraps the entity in { d: {...} }; V4 returns the entity directly.
  const d = (json && json.d) || json || {}

  // TODO(IT): Map these to the real SAP field names for your service. The
  // right-hand sides below are the *conventional* BAPI_ALM_ORDER_GET_DETAIL /
  // IW32 field names — adjust to whatever your OData entity actually exposes.
  const description = d.ShortText || d.Description || d.MAKTX || d.SHORT_TEXT || ''
  const status = d.SystemStatus || d.Status || d.STAT || 'REL' // e.g. REL/CRTD/TECO
  const plant = d.Plant || d.WERKS || d.MaintPlant || ''
  const equipment = d.Equipment || d.EQUNR || d.EquipmentNumber || ''
  const functionalLocation = d.FunctionalLocation || d.TPLNR || d.FunctLocation || ''

  return {
    number: d.OrderNumber || d.Orderid || d.AUFNR || number,
    description,
    status,
    plant,
    equipment,
    functionalLocation,
    documentQuery: deriveDocumentQuery({ d, description, equipment }),
  }
}

// Derive the Document Centre query from the order. If SAP carries an explicit
// document number reference (DMS / task-list document), prefer it; otherwise
// fall back to keywords built from the equipment + short text.
function deriveDocumentQuery({ d, description, equipment }) {
  // TODO(IT): if your order/task list links a DMS document number (e.g. via
  // BAPI_DOCUMENT_* or a task-list header), map it here.
  const documentNumber = d.DocumentNumber || d.DOKNR || d.DMS_DOC || ''
  const systems = d.SystemGroup || d.MaintenanceSystem || 'Mechanical'
  const keywords = [description, equipment].filter(Boolean).join(' ').trim()
  return {
    documentNumber,
    keywords: keywords || description || '',
    systems,
  }
}

// ===========================================================================
// REAL MODE — SharePoint Document Centre
// ===========================================================================

// Build a KQL query string from the provided fields and hit the SharePoint
// Search REST API. Returns results already mapped to the contract shape, with
// each url rewritten to the /documents/fetch proxy on THIS service.
async function searchSharePoint(q, base) {
  const kql = buildKql(q)

  // SharePoint Search REST endpoint. selectproperties keeps the payload small.
  const url =
    `${SP_BASE_URL.replace(/\/+$/, '')}/_api/search/query` +
    `?querytext='${encodeURIComponent(kql)}'` +
    `&selectproperties='Title,Path,Filename,OriginalPath,DocId'` +
    `&rowlimit=25&clienttype='ASAaeiMiddleware'`

  const resp = await fetch(url, { headers: sharePointAuthHeaders() })
  if (!resp.ok) throw new Error(`SharePoint search responded ${resp.status}`)
  const json = await resp.json()

  const rows =
    json?.PrimaryQueryResult?.RelevantResults?.Table?.Rows || json?.d?.query?.PrimaryQueryResult?.RelevantResults?.Table?.Rows || []

  const results = (Array.isArray(rows) ? rows : rows.results || []).map((row, idx) => {
    const cells = row.Cells?.results || row.Cells || []
    const get = (key) => {
      const c = cells.find((x) => x.Key === key)
      return c ? c.Value : ''
    }
    const path = get('Path') || get('OriginalPath') || ''
    const title = get('Title') || ''
    const fileName = get('Filename') || fileNameFromPath(path)
    return {
      documentNumber: q.documentNumber || get('DocId') || '',
      title,
      fileName,
      // Proxy the actual file through this service so the browser avoids
      // SharePoint CORS/auth entirely.
      url: `${base}/documents/fetch?src=${encodeURIComponent(path)}`,
      score: scoreResult({ title, fileName }, q, idx),
    }
  })

  results.sort((a, b) => b.score - a.score)
  return results
}

// Compose a KQL querytext from the caller's fields.
function buildKql(q) {
  const parts = []
  if (q.documentNumber) parts.push(`"${q.documentNumber}"`)
  if (q.title) parts.push(`Title:"${q.title}"`)
  if (q.keywords) parts.push(q.keywords)
  if (q.systems) parts.push(q.systems)
  // Restrict to files under the Document Centre site.
  const kql = parts.filter(Boolean).join(' ')
  return kql || '*'
}

// Simple relevance heuristic used to rank/sort results best-first. SharePoint
// already returns them ranked; we nudge exact documentNumber/title hits up.
function scoreResult({ title, fileName }, q, idx) {
  let s = 0.5 + Math.max(0, 0.4 - idx * 0.05) // preserve engine order
  const hay = `${title} ${fileName}`.toLowerCase()
  if (q.documentNumber && hay.includes(q.documentNumber.toLowerCase())) s += 0.3
  if (q.title && title.toLowerCase().includes(q.title.toLowerCase())) s += 0.2
  return Math.min(1, Number(s.toFixed(2)))
}

// Stream a SharePoint file back through this service.
async function proxySharePointFile(src, res) {
  const resp = await fetch(src, { headers: sharePointAuthHeaders() })
  if (!resp.ok) throw new Error(`SharePoint file responded ${resp.status}`)

  const ct = resp.headers.get('content-type') || 'application/octet-stream'
  res.setHeader('Content-Type', ct)
  const name = fileNameFromPath(src) || 'document'
  res.setHeader('Content-Disposition', `inline; filename="${name}"`)

  // Node 18+ fetch returns a web ReadableStream; buffer it and send.
  const buf = Buffer.from(await resp.arrayBuffer())
  res.end(buf)
}

// Auth headers for SharePoint REST calls.
function sharePointAuthHeaders() {
  const headers = { Accept: 'application/json;odata=verbose' }
  if (SP_BEARER) {
    headers.Authorization = `Bearer ${SP_BEARER}`
  }
  // TODO(IT): If your Document Centre uses NTLM / Windows integrated auth or a
  // FedAuth/rtFa cookie instead of a bearer token, wire it here — e.g. attach a
  // Cookie header, or replace `fetch` with an NTLM-capable client such as
  // `httpntlm` / `node-fetch` + `keerti-ntlm`. Keep credentials in env vars.
  return headers
}

function fileNameFromPath(p) {
  try {
    const clean = String(p || '').split('?')[0]
    const seg = clean.split('/').filter(Boolean).pop() || ''
    return decodeURIComponent(seg)
  } catch {
    return ''
  }
}

// ===========================================================================
// MOCK MODE — sample data + generated inspection PDF
// ===========================================================================

function mockWorkOrder(number) {
  return {
    number: number, // echo back the requested number
    description: 'Cooling Tower Performance Inspection',
    status: 'REL',
    plant: 'SYD',
    equipment: 'CT-01',
    functionalLocation: 'SYD-MECH-CT-01',
    documentQuery: {
      documentNumber: 'AEI-3.3007',
      keywords: 'Cooling Towers Performance inspection record',
      systems: 'Mechanical',
    },
  }
}

function mockSearch(q, base) {
  return {
    results: [
      {
        documentNumber: q.documentNumber || 'AEI-3.3007',
        title: 'Cooling Towers Performance inspection record',
        fileName: 'AppendixB.pdf',
        url: `${base}/documents/fetch?src=${encodeURIComponent('mock:appendixB')}`,
        score: 0.95,
      },
    ],
  }
}

// Generate a realistic single-page A4 inspection form with pdf-lib. The header
// row spreads "1M 3M 6M 1Y Remarks" across columns ~x=300..560, task labels
// start at x=40, and the status/Remarks cells are left BLANK so the ASAaei
// app's PDF field auto-detection can find the columns.
async function buildMockInspectionPdf() {
  const A4_W = 595.28
  const A4_H = 841.89

  const doc = await PDFDocument.create()
  const page = doc.addPage([A4_W, A4_H])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const faint = rgb(0.75, 0.75, 0.75)
  const ink = rgb(0.1, 0.1, 0.1)

  // Title block
  page.drawText('Cooling Towers Performance Inspection Record', {
    x: 40,
    y: A4_H - 55,
    size: 14,
    font: bold,
    color: ink,
  })
  page.drawText('Document: AEI-3.3007   Appendix B   Systems: Mechanical', {
    x: 40,
    y: A4_H - 74,
    size: 9,
    font,
    color: ink,
  })

  // Table geometry
  const leftX = 40 // task label column start
  const rightX = 560 // right edge of table
  const headerY = A4_H - 110 // baseline of header text
  const topLineY = headerY + 14 // line above header
  const rowHeight = 26

  // Column header x-positions spread across ~300..560.
  const columns = [
    { label: '1M', x: 300 },
    { label: '3M', x: 340 },
    { label: '6M', x: 380 },
    { label: '1Y', x: 420 },
    { label: 'Remarks', x: 470 },
  ]

  // Header labels
  page.drawText('Task', { x: leftX, y: headerY, size: 10, font: bold, color: ink })
  for (const c of columns) {
    page.drawText(c.label, { x: c.x, y: headerY, size: 10, font: bold, color: ink })
  }

  // Task rows (status/Remarks cells intentionally left blank)
  const tasks = [
    'Check water clarity in basin',
    'Check operation of bleed solenoid',
    'Operate all drainage points and flush',
    'Clean all conductivity sensors',
    'Inspect fan blades and drive belts',
    'Check make-up water float valve',
    'Verify chemical dosing pump operation',
    'Inspect drift eliminators for damage',
  ]

  const nRows = tasks.length
  const bottomLineY = topLineY - (nRows + 1) * rowHeight

  // Faint vertical column separators (before each status column + table edges).
  const vLines = [leftX, 290, ...columns.slice(1).map((c) => c.x - 10), rightX]
  for (const x of vLines) {
    page.drawLine({
      start: { x, y: topLineY },
      end: { x, y: bottomLineY },
      thickness: 0.5,
      color: faint,
    })
  }

  // Faint horizontal row lines.
  for (let i = 0; i <= nRows + 1; i++) {
    const y = topLineY - i * rowHeight
    page.drawLine({
      start: { x: leftX, y },
      end: { x: rightX, y },
      thickness: 0.5,
      color: faint,
    })
  }

  // Task labels in the left column, one per row below the header row.
  tasks.forEach((t, i) => {
    const y = headerY - (i + 1) * rowHeight
    page.drawText(t, { x: leftX + 2, y: y + 8, size: 9, font, color: ink })
  })

  const bytes = await doc.save()
  return bytes
}

// ===========================================================================
app.listen(PORT, () => {
  console.log(
    `ASAaei work-order middleware listening on :${PORT} (mode: ${MOCK ? 'MOCK' : 'REAL'})`
  )
  if (!MOCK) {
    console.log(`  SAP OData : ${SAP_ODATA_URL}`)
    console.log(`  SharePoint: ${SP_BASE_URL}`)
  }
})
