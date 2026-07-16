import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { isStatusToken, norm } from './fieldClassify.js'

// ---------------------------------------------------------------------------
// Ruled-box detection
// ---------------------------------------------------------------------------
// Official inspection forms draw their answer areas as real ruled boxes — table
// cell borders. Reading the *drawn geometry* (rectangles and horizontal/vertical
// lines) lets us drop a field exactly inside each empty box, so fields sit neatly
// in the cells and no box is missed — including grids with no text to anchor to
// (the "Unit Details" grid). Text positions are used only to (a) skip cells that
// already contain text and (b) label the columns (status vs text).

const { OPS, Util } = pdfjsLib

export async function detectPdfBoxes(bytes) {
  const worker = new pdfjsLib.PDFWorker({ port: new PdfWorker() })
  const task = pdfjsLib.getDocument({ data: bytes.slice(), worker })
  const fields = []
  try {
    const pdf = await task.promise
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      const { width: pw, height: ph } = page.getViewport({ scale: 1 })
      const [opList, textContent] = await Promise.all([page.getOperatorList(), page.getTextContent()])
      const { hlines, vlines, rects } = collectGeometry(opList, ph)
      const cells = buildCells(hlines, vlines, rects, pw, ph)
      const texts = textContent.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ str: it.str.trim(), x: it.transform[4], xr: it.transform[4] + (it.width || 0), yTop: ph - it.transform[5] }))
      fields.push(...cellsToFields(cells, texts, pw, ph, p - 1))
      if (fields.length > 800) break
    }
    return fields
  } finally {
    task.destroy?.()
    worker.destroy?.()
  }
}

// Walk the operator list, tracking the CTM, and collect axis-aligned lines and
// rectangles in top-origin point coordinates.
function collectGeometry(opList, ph) {
  const { fnArray, argsArray } = opList
  const hlines = [] // { y, x1, x2 }
  const vlines = [] // { x, y1, y2 }
  const rects = []  // { x, y, w, h } top-origin
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack = []
  const toTop = (pt) => [pt[0], ph - pt[1]]

  const addSeg = (ax, ay, bx, by) => {
    if (Math.abs(ay - by) <= 1.2 && Math.abs(ax - bx) > 3) hlines.push({ y: (ay + by) / 2, x1: Math.min(ax, bx), x2: Math.max(ax, bx) })
    else if (Math.abs(ax - bx) <= 1.2 && Math.abs(ay - by) > 3) vlines.push({ x: (ax + bx) / 2, y1: Math.min(ay, by), y2: Math.max(ay, by) })
  }
  const addRect = (x, y, w, h) => {
    // corners in user space -> top-origin
    const p1 = toTop(Util.applyTransform([x, y], ctm))
    const p2 = toTop(Util.applyTransform([x + w, y + h], ctm))
    const rx = Math.min(p1[0], p2[0]), ry = Math.min(p1[1], p2[1])
    const rw = Math.abs(p2[0] - p1[0]), rh = Math.abs(p2[1] - p1[1])
    rects.push({ x: rx, y: ry, w: rw, h: rh })
    // its edges also feed the line grid
    addSeg(rx, ry, rx + rw, ry); addSeg(rx, ry + rh, rx + rw, ry + rh)
    addSeg(rx, ry, rx, ry + rh); addSeg(rx + rw, ry, rx + rw, ry + rh)
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() || ctm
    else if (fn === OPS.transform) ctm = Util.transform(ctm, argsArray[i])
    else if (fn === OPS.constructPath) {
      const ops = argsArray[i][0]
      const co = argsArray[i][1]
      let k = 0
      let cur = null
      let start = null // subpath start, for closePath
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = toTop(Util.applyTransform([co[k], co[k + 1]], ctm)); start = cur; k += 2 }
        else if (op === OPS.lineTo) { const nx = toTop(Util.applyTransform([co[k], co[k + 1]], ctm)); k += 2; if (cur) addSeg(cur[0], cur[1], nx[0], nx[1]); cur = nx }
        else if (op === OPS.rectangle) { addRect(co[k], co[k + 1], co[k + 2], co[k + 3]); k += 4 }
        else if (op === OPS.curveTo) { cur = toTop(Util.applyTransform([co[k + 4], co[k + 5]], ctm)); k += 6 }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { cur = toTop(Util.applyTransform([co[k + 2], co[k + 3]], ctm)); k += 4 }
        else if (op === OPS.closePath) { if (cur && start) { addSeg(cur[0], cur[1], start[0], start[1]); cur = start } }
      }
    }
  }
  return { hlines, vlines, rects }
}

// Build closed cell rectangles from the line grid (and keep explicit rects).
// Reconstruction is done per horizontal band using only the vertical lines that
// actually span that band, so an unrelated table's borders can't fragment a
// grid's columns (and vice-versa).
function buildCells(hlines, vlines, rects, pw, ph) {
  const cells = []
  const seen = new Set()
  const push = (r) => {
    if (r.w < 14 || r.h < 8 || r.w > pw * 0.92 || r.h > ph * 0.55) return
    const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`
    if (seen.has(key)) return
    seen.add(key); cells.push(r)
  }
  for (const r of rects) push(r) // explicit rectangles are cells directly

  const ys = cluster(hlines.map((h) => h.y))
  const xsAll = cluster(vlines.map((v) => v.x))
  const hAt = (y, x1, x2) => hlines.some((h) => Math.abs(h.y - y) <= 3 && h.x1 <= x1 + 3 && h.x2 >= x2 - 3)
  const vSpan = (x, y1, y2) => vlines.some((v) => Math.abs(v.x - x) <= 3 && v.y1 <= y1 + 3 && v.y2 >= y2 - 3)

  for (let j = 0; j < ys.length - 1; j++) {
    const y1 = ys[j], y2 = ys[j + 1]
    if (y2 - y1 < 8) continue
    const vs = xsAll.filter((x) => vSpan(x, y1, y2)) // only verticals bounding this band
    for (let k = 0; k < vs.length - 1; k++) {
      const x1 = vs[k], x2 = vs[k + 1]
      if (hAt(y1, x1, x2) && hAt(y2, x1, x2)) push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
    }
  }
  return cells
}

// Turn empty cells into fields, classified by width and column header.
function cellsToFields(cells, texts, pw, ph, pageIndex) {
  if (cells.length < 4) return [] // not a form grid on this page
  const out = []
  const median = medianOf(cells.map((c) => c.w)) || 40

  for (const c of cells) {
    // skip cells that already contain text (labels / filled values)
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2
    const hasText = texts.some((t) => t.x < cx && t.xr > c.x && t.yTop > c.y - 2 && t.yTop < c.y + c.h + 2 && overlapX(t, c) > 4)
    if (hasText) continue

    // status if the column is narrow, or a status header sits above it
    const narrow = c.w < Math.min(median * 0.7, pw * 0.09)
    const headerStatus = texts.some((t) => isStatusToken(t.str) && t.x < cx && t.xr > c.x && t.yTop < c.y)
    let type = narrow || headerStatus ? 'status' : 'text'

    // the row label sits to the left of the cell on the same row — use it as
    // the field label so profile autofill (SAP ID, name, date) still works
    const rowLabel = norm(texts
      .filter((t) => t.xr <= c.x + 4 && t.yTop > c.y - 2 && t.yTop < c.y + c.h + 4)
      .sort((a, b) => a.x - b.x).map((t) => t.str).join(' ')).slice(-48)

    if (type === 'text' && /signature/i.test(rowLabel)) type = 'signature'

    const pad = 1.5
    out.push({
      type, page: pageIndex, options: [], value: type === 'signature' ? null : '', auto: true,
      label: type === 'status' ? 'Result' : (rowLabel || (type === 'signature' ? 'Signature' : 'Entry')),
      xPct: (c.x + pad) / pw, yPct: (c.y + pad) / ph,
      wPct: (c.w - pad * 2) / pw, hPct: (c.h - pad * 2) / ph,
    })
    if (out.length > 800) break
  }
  return out
}

function overlapX(t, c) { return Math.min(t.xr, c.x + c.w) - Math.max(t.x, c.x) }

// Cluster nearby coordinates into representative positions.
function cluster(values, tol = 2.5) {
  const s = [...values].sort((a, b) => a - b)
  const out = []
  for (const v of s) {
    if (out.length && Math.abs(v - out[out.length - 1]) <= tol) continue
    out.push(v)
  }
  return out
}

function medianOf(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
