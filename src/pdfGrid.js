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
  return dedupeCells(cells)
}

// Overlap area of two axis-aligned rectangles.
function rectOverlap(a, b) {
  const x = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const y = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return x > 0 && y > 0 ? x * y : 0
}

// Collapse redundant rectangles so one visual box yields one field. These forms
// (Word exported to PDF) draw, for every answer cell, BOTH the real ruled table
// cell AND one or more smaller invisible content-control placeholders nested
// inside it — so a single box sprouts two or three overlapping fields ("two
// boxes in one"). The same box is also often drawn twice (an explicit rectangle
// plus the same box reconstructed from its edges).
//
// Two passes:
//   1. Drop near-identical duplicates (same box, ~same size, high overlap).
//   2. Resolve nesting: keep the OUTER ruled cell and drop the placeholders
//      inside it — UNLESS the outer is a big table/section frame (much larger
//      than a normal cell in BOTH axes), in which case it's not an input and we
//      keep its children instead.
export function dedupeCells(cells) {
  const area = (c) => c.w * c.h
  // pass 1 — near-identical duplicates (process largest-first, keep the first).
  const uniq = []
  for (const c of [...cells].sort((a, b) => area(b) - area(a))) {
    const dup = uniq.some((k) => {
      const lo = Math.min(area(c), area(k)), hi = Math.max(area(c), area(k))
      return lo >= 0.9 * hi && rectOverlap(c, k) >= 0.8 * lo
    })
    if (!dup) uniq.push(c)
  }
  if (uniq.length < 2) return uniq

  // pass 2 — nesting. A frame is a container far bigger than a typical cell in
  // both width and height (a whole table or a boxed section), so its children
  // are the real cells; a normal cell is only a little bigger than the
  // placeholders it wraps, so the cell itself is the field.
  const medW = medianOf(uniq.map((c) => c.w)) || 1
  const medH = medianOf(uniq.map((c) => c.h)) || 1
  const isFrame = (c) => c.w > medW * 3 && c.h > medH * 3
  const contains = (B, A) => area(A) < area(B) * 0.98 && rectOverlap(A, B) >= 0.8 * area(A)

  // parent = the smallest cell that contains it
  const parent = uniq.map((a, i) => {
    let best = -1, bestArea = Infinity
    for (let j = 0; j < uniq.length; j++) {
      if (j === i) continue
      if (contains(uniq[j], a) && area(uniq[j]) < bestArea) { best = j; bestArea = area(uniq[j]) }
    }
    return best
  })
  return uniq.filter((c, i) => {
    if (isFrame(c) && uniq.some((o, j) => j !== i && contains(c, o))) return false // table/section frame
    // a nested cell whose container is a normal cell is a placeholder → drop it
    if (parent[i] >= 0 && !isFrame(uniq[parent[i]])) return false
    return true
  })
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
    // Sparse pre-printed text — the grading numbers "1 2 3 4 5" in the condition-
    // monitoring legend, a single shaded header word — covers only a sliver of a
    // wide or tall cell, so the overlap test above misses it and a field lands on
    // top, hiding the printout. Also count the cell occupied when a token's centre
    // point sits inside its interior (a left-hand row label, whose centre is off
    // to the left, still can't trip this).
    if (vOv > 1) {
      const tcx = (t.x + t.xr) / 2, tcy = (tTop + tBot) / 2
      if (tcx > c.x + 1 && tcx < cx1 - 1 && tcy > c.y && tcy < cy1) return true
    }
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

    // status if the column is narrow, or a narrow-ish column has a status header
    // (OK/Fail or 1M/3M/6M/1Y) directly above it. The header must be a real
    // status column heading — narrow and vertically aligned — so a wide free-text
    // box lower on the page (Parts Used, Comments) can't inherit "status" from
    // the frequency headers far above it.
    const narrow = c.w < Math.min(median * 0.7, pw * 0.09)
    const headerStatus = c.w < pw * 0.16 && texts.some((t) => {
      if (!isStatusToken(t.str) || t.yTop >= c.y) return false
      const tcx = (t.x + t.xr) / 2
      return tcx > c.x - 2 && tcx < c.x + c.w + 2 // header sits in this column
    })
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
