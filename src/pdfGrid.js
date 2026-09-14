import { isStatusToken, isStatusHeaderToken, isRemarksToken, isReadingLabel, norm } from './fieldClassify.js'

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
  // A container whose direct children TILE it — two or more of them, together
  // covering nearly all of its area — is a band of cells drawn as one shape,
  // not a cell with a placeholder inside. Word and LibreOffice both paint the
  // shading of neighbouring cells as a single filled rectangle: one rectangle
  // across a shaded table row, or down a shaded column. Without this, that
  // rectangle counted as the cell, its real cells were dropped as
  // "placeholders", and — since the rectangle also held the row's label — the
  // whole row got no boxes. On the performance test run table every second
  // row is shaded, so every second row was missing (and the shaded reading
  // columns of the condition monitoring matrix were missing entirely). A
  // cell with a couple of small placeholders in it covers far less than that
  // (the 18×28 cell with 13×14 + 13×8 placeholders is 57%), so it still reads
  // as a cell.
  const children = uniq.map(() => [])
  parent.forEach((p, i) => { if (p >= 0) children[p].push(i) })
  const isTiled = (i) => children[i].length >= 2
    && children[i].reduce((s, j) => s + area(uniq[j]), 0) >= 0.8 * area(uniq[i])
  const isContainer = (i) => isTiled(i)
    || (isFrame(uniq[i]) && uniq.some((o, j) => j !== i && contains(uniq[i], o)))
  return uniq.filter((c, i) => {
    if (isContainer(i)) return false // table/section frame or a shading band
    // a nested cell whose container is a normal cell is a placeholder → drop it
    if (parent[i] >= 0 && !isContainer(parent[i])) return false
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

// A box shorter than a line of type cannot be written in — it is a rule, a
// spacer or the gap between two table borders, never an input.
const MIN_CELL_H = 10 // points

// How much of a label is kept as a field's placeholder. It is the START of the
// label that is kept: "Check condition of all engine couplings, includ…" tells
// the tech which row they are on, where the old tail ("d water pump couplin")
// told them nothing — and the profile autofill patterns are anchored at the
// start too ("Date …", "Name …").
const LABEL_MAX = 60

// Everything the detector can find on one page: the fields inside empty ruled
// cells, the boxes beside a printed prompt inside a cell ("Record water
// added"), and the fields on write-on lines ("Fuel start: ____Litres",
// "Notes/Remarks:" over rows of dashes). `hlines` are the page's horizontal
// rules, for the drawn (not typed) write-on lines. Same coordinate frame and
// field model throughout.
export function detectPageFields({ cells, texts, hlines = [], pw, ph, pageIndex, images = [] }) {
  const out = cellsToFields(cells, texts, pw, ph, pageIndex, images)
  const taken = (r) => out.some((f) => {
    const fr = { x: f.xPct * pw, y: f.yPct * ph, w: f.wPct * pw, h: f.hPct * ph }
    return rectOverlap(fr, r) > 0.5 * r.w * r.h
  })
  const add = (f) => {
    if (out.length >= MAX_FIELDS_PER_PAGE) return
    if (taken({ x: f.xPct * pw, y: f.yPct * ph, w: f.wPct * pw, h: f.hPct * ph })) return
    out.push(f)
  }
  if (cells.length >= 4) for (const f of promptFields(cells, texts, pw, ph, pageIndex)) add(f)
  for (const f of blankLineFields(texts, hlines, cells, pw, ph, pageIndex)) add(f)
  return out
}

// Turn empty cells into fields, classified by width and column header.
export function cellsToFields(rawCells, texts, pw, ph, pageIndex, images = []) {
  if (rawCells.length < 4) return [] // not a form grid on this page
  const cells = mergeSplitCells(rawCells, texts)
  const out = []
  const median = medianOf(cells.map((c) => c.w)) || 40
  const textIn = cellTextLookup(cells, texts)
  const headerFor = columnHeaderLookup(cells, textIn)

  // The printed column-title row: a Remarks/Comments heading, or a paired
  // "Pass/Fail"-style status heading, in a cell of its own, with the table's
  // row-label column somewhere to its left. Any empty cell on that same row is
  // a title/label box, not an input, so the whole header row is skipped
  // including its empty label cell.
  //
  // The heading has to be the WHOLE text of its cell. Matching the words
  // wherever they appeared on the row skipped every row whose task text
  // happened to wrap onto a line reading "condition", or carried a "Note:" —
  // on the generator procedure that was B.2.9, B.2.12 and every row of the
  // condition monitoring matrix, all of which opened with no boxes. (A lone
  // "OK"/"Pass" *value* is deliberately not counted, so re-opening a
  // part-filled form can't mistake its answers for headings.)
  const inHeaderRow = headerRowTest(cells, textIn)
  const isTopCaptionCell = topCaptionTest(cells, texts)

  // A cell is "occupied" by a picture when the picture covers most of it — a
  // framed logo, a diagram in a bordered panel. Those read as empty boxes to
  // the line grid, because the only thing inside them is an image.
  const holdsImage = (c) => images.some((im) => {
    const ox = Math.min(im.x + im.w, c.x + c.w) - Math.max(im.x, c.x)
    const oy = Math.min(im.y + im.h, c.y + c.h) - Math.max(im.y, c.y)
    if (ox <= 0 || oy <= 0) return false
    return (ox * oy) >= (c.w * c.h) * 0.55
  })
  const rowLabelFor = rowLabelLookup(cells, texts, textIn)

  for (const c of cells) {
    // skip cells that already contain text (labels / printed codes / values)
    if (cellHasText(c, texts)) continue
    // skip empty cells that sit on the printed header/title row
    if (inHeaderRow(c) || isTopCaptionCell(c)) continue
    // skip what is physically not a box to write in
    if (c.h < MIN_CELL_H) continue
    if (holdsImage(c)) continue

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
    // a hundred times instead of tapping. The column's own heading cell is
    // read first (so a wrapped "Pass/ Fail" is one heading, not a stray
    // "Fail"); failing that, a status token anywhere above in the column.
    const isStatusHeading = (t) => !!t && (isStatusToken(t) || isStatusHeaderToken(t))
    let statusHeading = ''
    if (c.w < pw * 0.16) {
      const heading = headerFor(c)
      if (isStatusHeading(heading)) statusHeading = heading
      else {
        const tok = texts.find((t) => {
          if (t.yTop >= c.y || !isStatusHeading(t.str)) return false
          const tcx = (t.x + t.xr) / 2
          return tcx > c.x - 2 && tcx < c.x + c.w + 2 // header sits in this column
        })
        if (tok) statusHeading = tok.str
      }
    }
    // the row label sits to the left of the cell on the same row — use it as
    // the field label so profile autofill (SAP ID, name, date) still works
    const rowLabel = rowLabelFor(c)
    const heading = headerFor(c)

    // A box that asks for a FIGURE is typed into, however narrow it is. The
    // performance test run table is twelve narrow columns against row labels
    // like "Voltage (R): Volts" and "Oil Press. Main: kPa"; the condition
    // monitoring matrix has "Grading (1-5)" and "Actual Reading" columns. As
    // tap-cells those could only say OK / N/A / Fail, and the tech had to
    // switch every page to manual entry to type a reading. A status heading
    // on the column ("Result", "Pass/Fail", "1M") still wins: a task that
    // mentions a temperature is still a task to be checked off.
    const asksForFigure = !statusHeading && (isReadingLabel(heading) || isReadingLabel(rowLabel))
    let type = statusHeading || (narrow && !asksForFigure) ? 'status' : 'text'

    if (type === 'text' && /signature/i.test(rowLabel)) type = 'signature'

    // Label priority: the row's own label ("SAP ID", "Site name") drives both
    // the placeholder and profile autofill, so it wins — unless the column's
    // heading names the figure wanted ("Actual Reading", "Grading (1-5)",
    // "Model"), which says more than the row does. Failing both, the column's
    // printed heading — in a grid like "Test equipment | Model | Barcode no. |
    // Calibration due date" there is no row label at all, and the heading is
    // the only thing that tells the tech what goes in the box. A generic
    // "Entry" is the last resort, not the default.
    const label = type === 'status'
      ? 'Result'
      : ((isReadingLabel(heading) && !isReadingLabel(rowLabel) ? heading : '')
        || rowLabel || heading || (type === 'signature' ? 'Signature' : 'Entry'))

    // A status cell carries the wording its own column asks for, so a
    // "Pass/Fail" column cycles Pass → N/A → Fail rather than stamping "OK"
    // into a form that never uses the word. Empty means the default cycle.
    out.push(mkField(type, pageIndex, c, pw, ph, label, type === 'status' ? statusCycleFor(statusHeading) : []))
    if (out.length >= MAX_FIELDS_PER_PAGE) break
  }
  return out
}

// One field, inset a touch from the box it sits in, in page fractions.
function mkField(type, pageIndex, box, pw, ph, label, options = [], pad = 1.5) {
  return {
    type, page: pageIndex, options,
    value: type === 'signature' ? null : '', auto: true,
    label: norm(label).slice(0, LABEL_MAX),
    xPct: (box.x + pad) / pw, yPct: (box.y + pad) / ph,
    wPct: (box.w - pad * 2) / pw, hPct: (box.h - pad * 2) / ph,
  }
}

// The label for a cell: the text of the row's leftmost text cell (plus the
// next one when the first is just a clause number like "B.2.10"), or, when
// the text to the left is not in cells at all, all of it. Only text LEFT of
// the cell on its own row counts, and text in other columns' answer cells
// ("N/A N/A" in the LUL/LPL columns) is left out of it.
function rowLabelLookup(cells, texts, textIn) {
  const cellOf = (t) => {
    const th = t.h || 9
    const tcx = (t.x + t.xr) / 2, tcy = t.yTop - th * 0.3
    return cells.find((c) => tcx > c.x && tcx < c.x + c.w && tcy > c.y && tcy < c.y + c.h)
  }
  return (c) => {
    const left = texts
      .filter((t) => t.xr <= c.x + 4 && t.yTop > c.y - 2 && t.yTop < c.y + c.h + 4)
      .sort((a, b) => a.x - b.x)
    if (!left.length) return ''
    const inCells = new Map()
    const loose = []
    for (const t of left) {
      const host = cellOf(t)
      if (host) inCells.set(host, true); else loose.push(t)
    }
    const hosts = [...inCells.keys()].sort((a, b) => a.x - b.x)
    if (!hosts.length) return norm(loose.map((t) => t.str).join(' '))
    let label = textIn(hosts[0])
    if (label.length <= 8 && hosts[1]) label += ' ' + textIn(hosts[1])
    return norm(label)
  }
}

// Which cells sit on a printed column-title row (see cellsToFields).
function headerRowTest(cells, textIn) {
  const sameRow = (a, b) => {
    const ov = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    return ov >= 0.5 * Math.min(a.h, b.h)
  }
  const isHeading = (c) => {
    const t = textIn(c)
    return !!t && t.length <= 40 && (isRemarksToken(t) || isStatusHeaderToken(t))
  }
  const header = new Set()
  for (const h of cells) {
    if (!isHeading(h)) continue
    const row = cells.filter((c) => sameRow(c, h))
    // A heading in the first column is a row label ("Remarks: | ____"), not a
    // column title: the value box beside it is there to be filled.
    if (!row.some((c) => c !== h && c.x + c.w <= h.x + 2)) continue
    for (const c of row) header.add(c)
  }
  return (c) => header.has(c)
}

// Boxes beside a printed prompt inside a cell. "Record water added" or
// "Start batteries:" printed in an answer cell is an instruction to write
// something next to it, but the printed words made the cell read as filled,
// so the tech had nowhere to type. Each such prompt gets a box: to its right
// when the cell has room there, otherwise in the blank space under it.
const PROMPT_RX = /^(?:record|enter|note|write|state|specify|list|measure|indicate|insert|type|tick|circle|initial|sign|print|attach|describe|give|provide)\b|:$/i

function promptFields(cells, texts, pw, ph, pageIndex) {
  const out = []
  const pad = 1.5
  for (const c of cells) {
    if (c.h < MIN_CELL_H) continue
    const inside = texts.filter((t) => {
      const th = t.h || 9
      const tcx = (t.x + t.xr) / 2, tcy = t.yTop - th * 0.3
      return tcx > c.x && tcx < c.x + c.w && tcy > c.y && tcy < c.y + c.h
    }).sort((a, b) => a.yTop - b.yTop || a.x - b.x)
    if (!inside.length) continue
    // A prompt cell has something to its left on its row (a task, a clause
    // number) — the leftmost column of a table describes rows, it never
    // prompts for an answer beside itself.
    if (!texts.some((t) => t.xr <= c.x + 2 && t.yTop > c.y && t.yTop < c.y + c.h)) continue
    const paras = paragraphsOf(inside)
    if (paras.length > 4 || !paras.every((p) => PROMPT_RX.test(p.text) && p.text.length <= 40)) continue

    for (let i = 0; i < paras.length; i++) {
      const p = paras[i]
      const label = p.text.replace(/:$/, '')
      const lineH = Math.max(p.h * 1.5, MIN_CELL_H)
      // To the right of the prompt's last line, if it leaves room to write.
      const right = c.x + c.w - pad
      const free = right - (p.xr + 3)
      if (free >= 40) {
        const y = Math.max(c.y + pad, p.yBottom - lineH * 0.9)
        out.push(mkField('text', pageIndex, { x: p.xr + 3, y, w: free, h: Math.min(lineH, c.y + c.h - pad - y) }, pw, ph, label, [], 0))
        continue
      }
      // Otherwise the blank band under it, down to the next prompt or the
      // cell's bottom edge.
      const top = p.yBottom + 2
      const bottom = paras[i + 1] ? paras[i + 1].yTop - paras[i + 1].h - 2 : c.y + c.h - pad
      if (bottom - top >= MIN_CELL_H) {
        out.push(mkField('text', pageIndex, { x: c.x + pad, y: top, w: c.w - pad * 2, h: bottom - top }, pw, ph, label, [], 0))
      }
    }
  }
  return out
}

// Group the text tokens of one cell into lines, and lines into paragraphs
// (consecutive lines spaced like wrapped text). Each paragraph: its text,
// the baseline of its first line (yTop), the bottom of its last line
// (yBottom), its right edge and its font height.
function paragraphsOf(tokens) {
  const lines = []
  for (const t of tokens) {
    const line = lines.find((l) => Math.abs(l.y - t.yTop) <= Math.max(t.h, l.h) * 0.4)
    if (line) { line.tokens.push(t); line.h = Math.max(line.h, t.h) } else lines.push({ y: t.yTop, h: t.h || 9, tokens: [t] })
  }
  lines.sort((a, b) => a.y - b.y)
  const paras = []
  for (const l of lines) {
    const text = norm(l.tokens.sort((a, b) => a.x - b.x).map((t) => t.str).join(' '))
    const xr = Math.max(...l.tokens.map((t) => t.xr))
    const last = paras[paras.length - 1]
    if (last && l.y - last.yLast <= last.h * 1.45) {
      last.text = norm(last.text + ' ' + text)
      last.yLast = l.y; last.yBottom = l.y + l.h * 0.25; last.xr = xr
    } else {
      paras.push({ text, h: l.h, yTop: l.y, yLast: l.y, yBottom: l.y + l.h * 0.25, xr })
    }
  }
  return paras
}

// Fields on write-on lines.
//
// Forms ask for a value on a line as often as in a box: "Fuel start:
// ____Litres", "Remarks/Derating:_______", "Genset:........", or a
// "Notes/Remarks:" heading over rows of dashes. Two ways those lines get onto
// the page, both handled here:
//
//   - typed: a run of underscores, dashes or dots in the text itself. The
//     run's extent along its token is worked out from the glyphs around it
//     (see runExtent), so the box starts where the label stops.
//   - drawn: a horizontal rule that is not a table border, with a label
//     beside it ("Signature: ______" set as a bottom border) or above it
//     ("Notes/Remarks:"), or the next rule in a stack of such lines.
//
// A rule with text sitting directly on top of it is the underline of a
// heading, and a rule with no label near it (the footer rule) is decoration:
// neither gets a box.
const BLANK_CHARS = '[_.\\u2026\\u00b7\\-\\u2010\\u2011\\u2012\\u2013\\u2014]'
const BLANK_RUN = new RegExp(`${BLANK_CHARS}{3,}`)            // has a run
const ENDS_BLANK = new RegExp(`${BLANK_CHARS}{3,}$`)          // ends in one
const BLANK_RUNS = () => new RegExp(`${BLANK_CHARS}{3,}`, 'g') // every run, fresh state

export function blankLineFields(texts, hlines, cells, pw, ph, pageIndex) {
  const out = []
  const byLine = (a, b) => Math.abs(a.yTop - b.yTop) <= Math.max(a.h, b.h) * 0.4
  const stripBlank = (s) => s.replace(BLANK_RUNS(), ' ').replace(/[:\s]+$/, '')

  // The label of a blank starting at x on a baseline: the words to its left on
  // that line (its own token's prefix, then the tokens before it while the
  // gaps are small), else a short caption just above its left end.
  const labelFor = (tok, prefix, x) => {
    const parts = [stripBlank(prefix)]
    let edge = tok.x
    const before = texts
      .filter((t) => t !== tok && byLine(t, tok) && t.xr <= edge + 1)
      .sort((a, b) => b.xr - a.xr)
    for (const t of before) {
      if (edge - t.xr > 14) break
      // a token that is, or ends in, another blank belongs to that blank
      if (ENDS_BLANK.test(t.str) || BLANK_RUN.test(t.str)) break
      parts.unshift(stripBlank(t.str))
      edge = t.x
    }
    const own = norm(parts.join(' '))
    if (own) return own
    // A caption above the line's left end: "Notes/Remarks:", "Comments".
    const above = texts
      .filter((t) => t.yTop < tok.yTop - tok.h * 0.5 && t.yTop > tok.yTop - tok.h * 3.2
        && t.x < x + 40 && t.xr > x - 10 && norm(t.str).length <= 40)
      .sort((a, b) => b.yTop - a.yTop)[0]
    return above ? stripBlank(above.str) : ''
  }

  const push = (box, label) => {
    if (box.w < 18 || box.h < 8) return
    const type = /signature|signed/i.test(label) ? 'signature' : 'text'
    out.push(mkField(type, pageIndex, box, pw, ph, label || 'Entry', [], 0))
  }
  const placed = [] // { y, x1, x2, label } — lines already given a box, for chaining

  // ---- typed runs ---------------------------------------------------------
  for (const t of texts) {
    const str = t.str
    const runs = BLANK_RUNS()
    let m
    while ((m = runs.exec(str))) {
      const [x1, x2] = runExtent(str, m.index, m.index + m[0].length, t.x, t.xr)
      const w = x2 - x1
      // An ellipsis inside prose is three dots wide; a write-on line is not.
      if (w < 18) continue
      const after = str.slice(m.index + m[0].length)
      const beforeTxt = str.slice(0, m.index)
      // A run wedged between two words is a compound word's hyphen, not a line.
      if (/\w$/.test(beforeTxt) && /^\w/.test(after) && after.length > 8) continue
      const h = Math.max(t.h * 1.35, MIN_CELL_H)
      const label = labelFor(t, beforeTxt, x1)
      push({ x: x1, y: t.yTop + t.h * 0.3 - h, w, h }, label)
      // a typed line is one a drawn rule below it can chain from
      placed.push({ y: t.yTop + t.h * 0.3, x1, x2, label })
    }
  }

  // ---- drawn rules --------------------------------------------------------
  const edgeOf = (l) => cells.some((c) => {
    const onEdge = Math.abs(c.y - l.y) <= 2 || Math.abs(c.y + c.h - l.y) <= 2
    return onEdge && Math.min(c.x + c.w, l.x2) - Math.max(c.x, l.x1) > 4
  })
  const rules = []
  for (const l of [...hlines].sort((a, b) => a.y - b.y || a.x1 - b.x1)) {
    if (l.x2 - l.x1 < 60 || l.x1 < 0 || l.x2 > pw) continue
    if (l.x2 - l.x1 > pw * 0.95) continue // page frame
    if (edgeOf(l)) continue
    // the same rule drawn twice (both edges of a hairline rectangle)
    if (rules.some((r) => Math.abs(r.y - l.y) <= 2 && Math.abs(r.x1 - l.x1) <= 4 && Math.abs(r.x2 - l.x2) <= 4)) continue
    // text sitting right on the line: the rule is an underline / heading border
    const underText = texts.some((t) => t.yTop <= l.y + 1 && t.yTop > l.y - t.h * 1.2
      && Math.min(t.xr, l.x2) - Math.max(t.x, l.x1) > 8)
    if (underText) continue
    rules.push(l)
  }
  const lineH = 13
  for (const l of rules) {
    let label = ''
    // (a) a label on the line, to its left
    const beside = texts
      .filter((t) => t.yTop <= l.y + 3 && t.yTop >= l.y - lineH * 1.2 && t.xr <= l.x1 + 4 && t.xr >= l.x1 - 60)
      .sort((a, b) => b.xr - a.xr)[0]
    if (beside) label = stripBlank(beside.str)
    // (b) a caption above the left end
    if (!label) {
      const above = texts
        .filter((t) => t.yTop < l.y - 2 && t.yTop > l.y - lineH * 3.2 && t.x < l.x1 + 40 && t.xr > l.x1 - 10
          && norm(t.str).length <= 40 && (/:$/.test(t.str) || isRemarksToken(t.str) || /signature|signed|name|date/i.test(t.str)))
        .sort((a, b) => b.yTop - a.yTop)[0]
      if (above) label = stripBlank(above.str)
    }
    // (c) the next line in a stack of write-on lines
    let chained = null
    if (!label) {
      chained = placed.find((p) => l.y - p.y > 4 && l.y - p.y <= 30 && Math.abs(p.x1 - l.x1) <= 10)
      if (chained) label = chained.label
    }
    if (!label) continue
    const prev = placed.filter((p) => p.y < l.y && Math.min(p.x2, l.x2) - Math.max(p.x1, l.x1) > 8).sort((a, b) => b.y - a.y)[0]
    const h = prev ? Math.min(lineH, l.y - prev.y - 1) : lineH
    push({ x: l.x1, y: l.y - h, w: l.x2 - l.x1, h }, label)
    placed.push({ y: l.y, x1: l.x1, x2: l.x2, label })
  }
  return out
}

// Where the characters [from, to) of a token fall along it. pdf.js gives the
// token's overall extent only, so the position is estimated from the glyph
// shapes: a dot or a colon is narrow, an underscore or a capital is wide, and
// the estimate is scaled so the whole string fits the measured width.
export function runExtent(str, from, to, x, xr) {
  const wOf = (ch) => {
    if (/[.,:;'!|il]/.test(ch)) return 0.28
    if (/[ Ijtfr]/.test(ch)) return 0.35
    if (ch === '-' || ch === '‐' || ch === '‑') return 0.36
    if (ch === '_' || ch === '–') return 0.5
    if (ch === '—' || ch === '…') return 1
    if (/[A-Z]/.test(ch)) return 0.68
    if (/[mwMW]/.test(ch)) return 0.85
    return 0.53
  }
  const widths = [...str].map(wOf)
  const total = widths.reduce((s, w) => s + w, 0) || 1
  const k = (xr - x) / total
  let acc = 0, x1 = x, x2 = xr
  for (let i = 0; i < widths.length; i++) {
    if (i === from) x1 = x + acc * k
    acc += widths[i]
    if (i === to - 1) { x2 = x + acc * k; break }
  }
  return [x1, x2]
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
// The text within a cell (tokens whose centre sits inside it), normalised,
// resolved once per cell and then reused.
function cellTextLookup(cells, texts) {
  const textCache = new Map()
  return (c) => {
    const key = `${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.w)},${Math.round(c.h)}`
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
}

function columnHeaderLookup(cells, textIn) {
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
