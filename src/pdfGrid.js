import { isStatusToken, isStatusHeaderToken, isRemarksToken, norm } from './fieldClassify.js'

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

// Upper bound on fields from a single page. A real form page tops out around a
// hundred; anything past this is a misread of a dense graphic, and placing
// hundreds of boxes on one page would make it unusable. Applied PER PAGE so a
// single odd page can never cost the rest of the document its fields.
const MAX_FIELDS_PER_PAGE = 250

// Turn empty cells into fields, classified by width and column header.
export function cellsToFields(rawCells, texts, pw, ph, pageIndex) {
  if (rawCells.length < 4) return [] // not a form grid on this page
  const cells = mergeSplitCells(rawCells, texts)
  const out = []
  const median = medianOf(cells.map((c) => c.w)) || 40
  const headerFor = columnHeaderLookup(cells, texts)

  // Header-row baselines: the printed column-title row carries titles that never
  // appear in a blank data cell — a Remarks/Comments heading, or a paired
  // "Pass/Fail"-style status heading. Any empty cell on that same row is a
  // title/label box, not an input, so we skip the whole header row including its
  // empty label cell. (A lone "OK"/"Pass" *value* is deliberately not counted,
  // so re-opening a part-filled form can't mistake its answers for headings.)
  const headerYs = texts
    .filter((t) => isRemarksToken(t.str) || isStatusHeaderToken(t.str))
    .map((t) => t.yTop)
  const onHeaderTextRow = (c) => headerYs.some((y) => y >= c.y - 3 && y <= c.y + c.h + 3)
  const isTopCaptionCell = topCaptionTest(cells, texts)
  const inHeaderRow = (c) => onHeaderTextRow(c) || isTopCaptionCell(c)

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
    // The heading above this column, if it marks the column as a status column.
    // Both spellings count: a bare frequency/result token ("1M", "OK"), and a
    // paired heading ("On Pass/Fail"), which is what the fire-and-smoke outcome
    // tables use. Those columns are wider than the narrow test allows, so
    // without this they became free-text boxes and the tech had to type "Pass"
    // a hundred times instead of tapping.
    const headerToken = c.w < pw * 0.16 && texts.find((t) => {
      if (t.yTop >= c.y) return false
      if (!isStatusToken(t.str) && !isStatusHeaderToken(t.str)) return false
      const tcx = (t.x + t.xr) / 2
      return tcx > c.x - 2 && tcx < c.x + c.w + 2 // header sits in this column
    })
    let type = narrow || headerToken ? 'status' : 'text'

    // the row label sits to the left of the cell on the same row — use it as
    // the field label so profile autofill (SAP ID, name, date) still works
    const rowLabel = norm(texts
      .filter((t) => t.xr <= c.x + 4 && t.yTop > c.y - 2 && t.yTop < c.y + c.h + 4)
      .sort((a, b) => a.x - b.x).map((t) => t.str).join(' ')).slice(-48)

    if (type === 'text' && /signature/i.test(rowLabel)) type = 'signature'

    // Label priority: the row's own label ("SAP ID", "Site name") drives both
    // the placeholder and profile autofill, so it wins. Failing that, use the
    // column's printed heading — in a grid like "Test equipment | Model |
    // Barcode no. | Calibration due date" there is no row label at all, and the
    // heading is the only thing that tells the tech what goes in the box. A
    // generic "Entry" is the last resort, not the default.
    const label = type === 'status'
      ? 'Result'
      : (rowLabel || headerFor(c) || (type === 'signature' ? 'Signature' : 'Entry'))

    const pad = 1.5
    out.push({
      type, page: pageIndex,
      // A status cell carries the wording its own column asks for, so a
      // "Pass/Fail" column cycles Pass → N/A → Fail rather than stamping "OK"
      // into a form that never uses the word. Empty means the default cycle.
      options: type === 'status' ? statusCycleFor(headerToken?.str) : [],
      value: type === 'signature' ? null : '', auto: true,
      label,
      xPct: (c.x + pad) / pw, yPct: (c.y + pad) / ph,
      wPct: (c.w - pad * 2) / pw, hPct: (c.h - pad * 2) / ph,
    })
    if (out.length >= MAX_FIELDS_PER_PAGE) break
  }
  return out
}

// Re-join a cell that a stray vertical line cut in two.
//
// Word draws a checkbox content control as a small square inside the answer
// cell. Its left and right edges land in the same line grid as the table's real
// borders, so `buildCells` reconstructs the row as two cells — the 19pt square
// and the 28pt remainder — where every other row of the same column has one
// 47pt cell. Both halves are empty, so the tech got two boxes side by side in a
// single tick cell.
//
// The tell comes from the table itself: other rows of the same column ARE a
// single 47pt cell starting at the same x. So when two touching empty cells add
// up to a span the table uses elsewhere, they are one cell that got cut, and we
// put them back together.
function mergeSplitCells(cells, texts) {
  const bandOf = (c) => Math.round(c.y / 3) // tolerate sub-pixel row jitter
  const bands = new Map()
  for (const c of cells) {
    const key = bandOf(c)
    if (!bands.has(key)) bands.set(key, [])
    bands.get(key).push(c)
  }
  // With only a couple of rows there is no other row to learn the column widths
  // from, and a genuinely irregular little table would be mangled. Leave it be.
  if (bands.size < 4) return cells

  // Every (start, width) span the table actually uses, at 2pt resolution.
  const spanKey = (x, w) => `${Math.round(x / 2)}:${Math.round(w / 2)}`
  const spans = new Set()
  for (const c of cells) spans.add(spanKey(c.x, c.w))
  // Allow a point or two of drift at either end when matching.
  const isKnownSpan = (x, w) => {
    for (const dx of [-1, 0, 1]) {
      for (const dw of [-1, 0, 1]) {
        if (spans.has(`${Math.round(x / 2) + dx}:${Math.round(w / 2) + dw}`)) return true
      }
    }
    return false
  }

  const merged = []
  for (const list of bands.values()) {
    const row = [...list].sort((a, b) => a.x - b.x)
    let run = null
    for (const c of row) {
      const joined = run && { ...run, w: c.x + c.w - run.x }
      const joins = run
        && Math.abs(run.x + run.w - c.x) <= 2       // touching
        && Math.abs(run.h - c.h) <= 3               // same row height
        && !cellHasText(run, texts) && !cellHasText(c, texts) // both blank
        && isKnownSpan(joined.x, joined.w)          // the column's real width
      if (joins) { run = joined; continue }
      if (run) merged.push(run)
      run = c
    }
    if (run) merged.push(run)
  }
  return merged
}

// The values a status cell should tap through, taken from its column heading.
// An empty result means "use the app's default cycle" (OK / N/A / Fail).
function statusCycleFor(heading) {
  return /pass/i.test(heading || '') ? ['Pass', 'N/A', 'Fail'] : []
}

// Recognise the blank cells in a table's TOP row that are there to caption the
// row-label column rather than to be filled in.
//
// A grouped header ("… | GFA | FAR1 | FAR2 | Manual Control | Indication") often
// leaves the first cell or two blank, above the row-label column. Those cells
// carry no heading text of their own, so the header-text rule above cannot see
// them, and they used to collect a field apiece sitting in the table's title
// bar. The tell is positional: the cell is on the table's topmost row and the
// rest of that row is captions.
function topCaptionTest(cells, texts) {
  if (!cells.length) return () => false
  const rowKey = (c) => Math.round(c.y / 4) // tolerate sub-pixel row jitter
  const top = Math.min(...cells.map(rowKey))
  const topRow = cells.filter((c) => rowKey(c) === top).sort((a, b) => a.x - b.x)
  // A caption bar spans a wide table; a two- or three-column form does not have
  // one, and reading it as one would cost that table its first row of boxes.
  if (topRow.length < 4) return () => false

  // The blanks must be a PREFIX of the row: the empty cells above the row-label
  // columns, with the captions filling everything to their right. That shape is
  // what a grouped header looks like. A blank anywhere else is a value cell —
  // "Site name | ______" is a data row, not a caption bar.
  let lead = 0
  while (lead < topRow.length && !cellHasText(topRow[lead], texts)) lead++
  if (lead === 0 || lead === topRow.length) return () => false
  if (!topRow.slice(lead).every((c) => cellHasText(c, texts))) return () => false
  // And the captions have to outnumber the blanks they are captioning.
  if (topRow.length - lead <= lead) return () => false

  const blanks = new Set(topRow.slice(0, lead))
  return (c) => blanks.has(c)
}

// Build a lookup from a cell to its column's printed heading.
//
// The heading is the nearest cell ABOVE this one that shares its column and
// contains text. Walking the cell grid rather than guessing from loose text
// positions keeps a caption from a different table (or a heading three tables
// up the page) from being adopted as this column's title.
function columnHeaderLookup(cells, texts) {
  // Text within a cell, resolved once per cell and then reused.
  const textCache = new Map()
  const textIn = (c) => {
    const key = `${Math.round(c.x)},${Math.round(c.y)}`
    if (textCache.has(key)) return textCache.get(key)
    const inside = texts
      .filter((t) => {
        const th = t.h || 9
        const tcx = (t.x + t.xr) / 2, tcy = t.yTop - th * 0.3
        return tcx > c.x && tcx < c.x + c.w && tcy > c.y && tcy < c.y + c.h
      })
      .sort((a, b) => a.yTop - b.yTop || a.x - b.x)
      .map((t) => t.str).join(' ')
    const val = norm(inside)
    textCache.set(key, val)
    return val
  }

  return (cell) => {
    // Every cell in this column above the one we are labelling, nearest first.
    // Blank cells are simply the empty data rows between this row and the
    // heading, so we walk up through them — stopping at the first blank would
    // label only the top row of a table and leave every row under it as
    // "Entry", which is the whole problem this is here to solve.
    const above = cells
      .filter((other) => {
        if (other === cell || other.y + other.h > cell.y + 2) return false
        const overlap = Math.min(other.x + other.w, cell.x + cell.w) - Math.max(other.x, cell.x)
        return overlap >= cell.w * 0.6 // same column
      })
      .sort((a, b) => b.y - a.y)

    for (const candidate of above) {
      const label = textIn(candidate)
      if (!label) continue // an empty row between here and the heading
      // The first text we meet going up is the column's heading. If it reads as
      // prose rather than a caption, this is not a headed column at all.
      return label.length <= 40 ? label : ''
    }
    return ''
  }
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
