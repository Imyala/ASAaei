import { isStatusToken, isRemarksToken, norm } from './fieldClassify.js'

// ---------------------------------------------------------------------------
// Pure grid geometry — build cells from a line grid and turn empty cells into
// fields. Kept free of any pdfjs import so it can be unit-tested in Node.
// `pdfBoxes.js` collects the raw geometry (which needs pdfjs) and calls in here.
// ---------------------------------------------------------------------------

// Build closed cell rectangles from the line grid (and keep explicit rects).
// Reconstruction is done per horizontal band using only the vertical lines that
// actually span that band, so an unrelated table's borders can't fragment a
// grid's columns (and vice-versa).
export function buildCells(hlines, vlines, rects, pw, ph) {
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

// True when a text token's box genuinely overlaps the cell's interior, in BOTH
// axes. `yTop` is the text baseline (top-origin) and `h` its font height, so we
// reconstruct the glyph box [baseline - 0.8h, baseline + 0.2h]. This catches
// centred and right-aligned header text ("Comments", "OFFICIAL") and the small
// pre-printed frequency codes (1M/3M/6M/1Y) that must NOT receive a field —
// the old test only saw text whose left edge was left of the cell centre and so
// missed all of those. It also uses a real vertical overlap instead of a loose
// baseline ± 2px window, so a neighbouring row's text can't mark this cell as
// occupied (which was skipping otherwise-empty first rows).
export function cellHasText(c, texts) {
  const cx1 = c.x + c.w, cy1 = c.y + c.h
  // Require more than an edge graze: a real intrusion into the cell interior.
  const needX = Math.min(c.w * 0.3, 8)
  const needY = Math.min(c.h * 0.3, 5)
  for (const t of texts) {
    const th = t.h || 9
    const tTop = t.yTop - th * 0.8
    const tBot = t.yTop + th * 0.2
    const hOv = Math.min(t.xr, cx1) - Math.max(t.x, c.x)
    const vOv = Math.min(tBot, cy1) - Math.max(tTop, c.y)
    if (hOv > needX && vOv > needY) return true
  }
  return false
}

// Turn empty cells into fields, classified by width and column header.
export function cellsToFields(cells, texts, pw, ph, pageIndex) {
  if (cells.length < 4) return [] // not a form grid on this page
  const out = []
  const median = medianOf(cells.map((c) => c.w)) || 40

  // Header-row baselines: the printed column-title row carries a Remarks/Comments
  // title (a word that never appears in a blank data cell). Any empty cell on that
  // same row is a title/label box, not an input — so we skip the whole header row,
  // including its empty label cell. (A stray OK/Fail/N/A value in a data cell is
  // NOT used here, so a filled answer can't be mistaken for a header.)
  const headerYs = texts.filter((t) => isRemarksToken(t.str)).map((t) => t.yTop)
  const inHeaderRow = (c) => headerYs.some((y) => y >= c.y - 3 && y <= c.y + c.h + 3)

  for (const c of cells) {
    // skip cells that already contain text (labels / printed codes / values)
    if (cellHasText(c, texts)) continue
    // skip empty cells that sit on the printed header/title row
    if (inHeaderRow(c)) continue

    // status if the column is narrow, or a status header sits above it
    const narrow = c.w < Math.min(median * 0.7, pw * 0.09)
    const headerStatus = texts.some((t) =>
      isStatusToken(t.str) && t.yTop < c.y && Math.min(t.xr, c.x + c.w) - Math.max(t.x, c.x) > 4)
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

// Cluster nearby coordinates into representative positions.
export function cluster(values, tol = 2.5) {
  const s = [...values].sort((a, b) => a - b)
  const out = []
  for (const v of s) {
    if (out.length && Math.abs(v - out[out.length - 1]) <= tol) continue
    out.push(v)
  }
  return out
}

export function medianOf(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
