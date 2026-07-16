import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { PDFDocument } from 'pdf-lib'
import { isStatusToken, isRemarksToken, norm } from './fieldClassify.js'
import { extractIdentity } from './docId.js'
import { detectPdfBoxes } from './pdfBoxes.js'

// Field labels we recognise in a details block (label → value on the same row).
// Deliberately specific so the many prose "reading" pages don't sprout fields.
const FIELD_LABELS = /^(site name|works?\s*plan number|inspected by|signature|sap id|log\s*book sheet( number)?|date( inspected)?|unit no\.?|work order|inspection type|serial( no)?|model no\.?|barcode|calibration( due)?( date)?|asset( no)?|equipment( no)?|technician|tech\s*cert)\b/i

// ---------------------------------------------------------------------------
// PDF field auto-detection
// ---------------------------------------------------------------------------
// Two strategies, tried in order:
//   1. AcroForm — if the PDF already carries real form fields, map them straight
//      onto our field model (most reliable, but many official forms are flat).
//   2. Text grid — reconstruct the inspection table from the positioned text:
//      find the header row (status columns like 1M/3M/6M/1Y or OK/Fail/N/A, plus
//      a Remarks/Comments column) and drop an OK/Fail/N/A dropdown into each empty
//      status cell and a text field into each empty Remarks cell, row by row.
// Everything is returned as page-relative fractions, matching the editor model.

export async function detectPdfFields(bytes) {
  // 1. Existing form fields (most reliable when present).
  const viaForm = await detectAcroForm(bytes).catch(() => [])
  if (viaForm.length) return viaForm
  // 2. Ruled boxes — a field inside each real cell (best alignment + coverage).
  const viaBoxes = await detectPdfBoxes(bytes).catch(() => [])
  if (viaBoxes.length >= 4) return viaBoxes
  // 3. Fall back to reconstructing the table from positioned text.
  return detectTextGrid(bytes).catch(() => [])
}

// ---- strategy 1: existing AcroForm fields ---------------------------------
async function detectAcroForm(bytes) {
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const form = pdfDoc.getForm()
  const fields = form.getFields()
  if (!fields.length) return []
  const pages = pdfDoc.getPages()

  const pageIndexForWidget = (widget) => {
    for (let i = 0; i < pages.length; i++) {
      const annots = pages[i].node.Annots()
      if (!annots) continue
      for (const ref of annots.asArray()) {
        if (pdfDoc.context.lookup(ref) === widget.dict) return i
      }
    }
    return 0
  }

  const out = []
  for (const field of fields) {
    const kind = field.constructor?.name
    let widgets = []
    try { widgets = field.acroField.getWidgets() } catch { widgets = [] }
    for (const w of widgets) {
      let rect
      try { rect = w.getRectangle() } catch { continue }
      if (!rect || rect.width < 4 || rect.height < 4) continue
      const idx = pageIndexForWidget(w)
      const { width: pw, height: ph } = pages[idx].getSize()
      const base = {
        page: idx,
        xPct: clamp01(rect.x / pw),
        yPct: clamp01((ph - rect.y - rect.height) / ph),
        wPct: clamp01(rect.width / pw),
        hPct: clamp01(rect.height / ph),
        label: safe(() => field.getName()) || 'Field',
        value: '',
        auto: true,
      }
      if (kind === 'PDFTextField') {
        out.push({ ...base, type: 'text', options: [] })
      } else if (kind === 'PDFDropdown' || kind === 'PDFOptionList') {
        const opts = safe(() => field.getOptions()) || []
        out.push({ ...base, type: 'dropdown', options: opts.length ? opts : [...OK_FAIL_NA] })
      } else if (kind === 'PDFCheckBox' || kind === 'PDFRadioGroup') {
        // Approximate a tick/choice control as an OK/Fail/N/A tri-state cell.
        out.push({ ...base, type: 'status', options: [] })
      }
    }
  }
  return out
}

// Read the document's identity (AEI number / title) from the first few pages,
// so the app can auto-apply a saved layout for that form. Best-effort.
export async function sniffPdfIdentity(bytes) {
  const worker = new pdfjsLib.PDFWorker({ port: new PdfWorker() })
  const task = pdfjsLib.getDocument({ data: bytes.slice(), worker })
  try {
    const pdf = await task.promise
    const maxP = Math.min(4, pdf.numPages)
    let text = ''
    for (let p = 1; p <= maxP; p++) {
      const page = await pdf.getPage(p)
      const tc = await page.getTextContent()
      const byLine = new Map()
      for (const it of tc.items) {
        if (!it.str) continue
        const key = Math.round(it.transform[5]) // baseline y
        byLine.set(key, (byLine.get(key) || '') + it.str + ' ')
      }
      const lines = [...byLine.entries()].sort((a, b) => b[0] - a[0]).map((e) => e[1].trim())
      text += lines.join('\n') + '\n'
    }
    return extractIdentity(text)
  } finally {
    task.destroy?.()
    worker.destroy?.()
  }
}

// ---- strategy 2: reconstruct the table from positioned text ---------------
async function detectTextGrid(bytes) {
  const worker = new pdfjsLib.PDFWorker({ port: new PdfWorker() })
  const task = pdfjsLib.getDocument({ data: bytes.slice(), worker })
  const fields = []
  try {
    const pdf = await task.promise
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      const { width: pw, height: ph } = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items = content.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => {
          const t = it.transform
          const fs = Math.abs(t[3]) || Math.abs(t[0]) || it.height || 10
          return { str: it.str.trim(), x: t[4], xr: t[4] + (it.width || 0), w: it.width || 0, fs, y: ph - t[5] }
        })
      if (items.length) fields.push(...detectPageGrid(items, pw, ph, p - 1))
      if (fields.length > 500) break // safety cap
    }
    return fields
  } finally {
    task.destroy?.()
    worker.destroy?.()
  }
}

// Group text items on one page into lines, find the header, place row fields.
function detectPageGrid(items, pw, ph, pageIndex) {
  const lines = groupLines(items)
  if (lines.length < 2) return []

  // Pick the header line: the one with the most status tokens (needs 2+, or a
  // remarks column plus at least one status token).
  let header = null
  for (const line of lines) {
    const status = line.tokens.filter((t) => isStatusToken(t.str))
    const remarks = line.tokens.find((t) => isRemarksToken(t.str))
    const score = status.length + (remarks ? 1 : 0)
    if ((status.length >= 2 || (status.length >= 1 && remarks)) && (!header || score > header.score)) {
      header = { line, status, remarks, score }
    }
  }
  // No OK/Fail/N/A grid on this page — try a label→value details block instead.
  if (!header) return detectLabelValue(lines, pw, ph, pageIndex)

  // Build status columns by clustering adjacent status tokens (so "OK / Fail /
  // N/A" collapses to one column, while "1M 3M 6M 1Y" stays four columns).
  const cols = clusterColumns(header.status)
  if (!cols.length) return []
  const spacings = cols.slice(1).map((c, i) => c.cx - cols[i].cx)
  const spacing = spacings.length ? median(spacings) : 90
  const colW = clampNum(spacing * 0.85, 24, 74)

  const firstColLeft = cols[0].xLeft
  const remarksLeft = header.remarks ? header.remarks.x : null
  const remarksRight = pw - 36
  // Label column = text left of the first status column.
  const labelX = Math.min(...header.line.tokens.filter((t) => t.x < firstColLeft - 4).map((t) => t.x), firstColLeft)

  const headerY = header.line.y
  const below = lines.filter((l) => l.y > headerY + 2).sort((a, b) => a.y - b.y)

  const out = []
  for (let i = 0; i < below.length; i++) {
    const line = below[i]
    // stop at a big vertical gap (end of the table)
    if (i > 0 && line.y - below[i - 1].y > line.fs * 4) break

    const hasLabel = line.tokens.some((t) => t.x <= firstColLeft - 6 && t.x >= labelX - 8)
    if (!hasLabel) continue
    const labelText = line.tokens.filter((t) => t.x < firstColLeft - 6).map((t) => t.str).join(' ')
    if (/^(general|notes?|section|remarks?)\b/i.test(norm(labelText))) continue // sub-heading, not a task row

    const rowTop = line.y - line.fs
    const nextY = below[i + 1] ? below[i + 1].y : line.y + line.fs * 1.6
    const rowH = clampNum(nextY - line.y, line.fs * 1.1, line.fs * 2.2)

    // status columns: place a dropdown where the cell is empty
    for (const col of cols) {
      const occupied = line.tokens.some((t) => t.xr > col.xLeft - 4 && t.x < col.xRight + 4)
      if (occupied) continue
      out.push(mkField('status', pageIndex, col.cx - colW / 2, rowTop, colW, rowH, pw, ph, [], 'Result'))
    }
    // remarks column: text field spanning to the right margin, if empty
    if (remarksLeft != null && remarksRight - remarksLeft > 30) {
      const occupied = line.tokens.some((t) => t.x >= remarksLeft - 4 && t.xr > remarksLeft + 6)
      if (!occupied) {
        out.push(mkField('text', pageIndex, remarksLeft, rowTop, remarksRight - remarksLeft, rowH, pw, ph, [], 'Remarks'))
      }
    }
    if (out.length > 500) break
  }
  return out
}

// A details block: rows like "Site name  ______", "SAP ID  ______",
// "Inspected by (Signature)  ______". Place a text (or signature) field to the
// right of each recognised label whose value area is empty.
function detectLabelValue(lines, pw, ph, pageIndex) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const labelTokens = line.tokens.filter((t) => t.x < pw * 0.55)
    if (!labelTokens.length) continue
    const labelText = norm(labelTokens.map((t) => t.str).join(' '))
    // Must be a short label, not a sentence of prose from a reading page.
    if (labelText.length > 40 || labelText.split(' ').length > 6) continue
    if (!FIELD_LABELS.test(labelText)) continue

    const rightOfLabel = Math.max(...labelTokens.map((t) => t.xr))
    const hasValue = line.tokens.some((t) => t.x > rightOfLabel + 10)
    if (hasValue) continue // value/next column already present

    const isSig = /signature/i.test(labelText)
    const x = rightOfLabel + 10
    const w = Math.min(pw - 40 - x, pw * 0.42)
    if (w < 40) continue
    const rowTop = line.y - line.fs
    const nextY = lines[i + 1] ? lines[i + 1].y : line.y + line.fs * 1.6
    const h = clampNum(nextY - line.y, line.fs * 1.2, isSig ? line.fs * 2.6 : line.fs * 2)
    out.push(mkField(isSig ? 'signature' : 'text', pageIndex, x, rowTop, w, h, pw, ph, [], labelText))
    if (out.length > 24) break
  }
  return out
}

function mkField(type, page, x, yTop, w, h, pw, ph, options, label) {
  const pad = 1
  return {
    type, page, options, value: '', auto: true, label,
    xPct: clamp01((x + pad) / pw),
    yPct: clamp01((yTop + pad) / ph),
    wPct: clamp01((w - pad * 2) / pw),
    hPct: clamp01((h - pad * 2) / ph),
  }
}

// Cluster a sorted list of status tokens into columns. A gap wider than the
// token height (roughly) between one token's right edge and the next token's
// left edge starts a new column.
function clusterColumns(statusTokens) {
  const toks = [...statusTokens].sort((a, b) => a.x - b.x)
  const cols = []
  let cur = null
  for (const t of toks) {
    const gap = cur ? t.x - cur.xRight : Infinity
    if (!cur || gap > Math.max(t.fs, 14)) {
      cur = { xLeft: t.x, xRight: t.xr, cx: (t.x + t.xr) / 2 }
      cols.push(cur)
    } else {
      cur.xRight = Math.max(cur.xRight, t.xr)
      cur.cx = (cur.xLeft + cur.xRight) / 2
    }
  }
  return cols
}

// Group items into text lines by their baseline y.
function groupLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines = []
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(it.fs, l.fs) * 0.6)
    if (line) {
      line.tokens.push(it)
      line.y = (line.y * (line.tokens.length - 1) + it.y) / line.tokens.length
      line.fs = Math.max(line.fs, it.fs)
    } else {
      lines.push({ y: it.y, fs: it.fs, tokens: [it] })
    }
  }
  lines.forEach((l) => l.tokens.sort((a, b) => a.x - b.x))
  return lines.sort((a, b) => a.y - b.y)
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0)
const clampNum = (v, lo, hi) => Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi)
const safe = (fn) => { try { return fn() } catch { return undefined } }
