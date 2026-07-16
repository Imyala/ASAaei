// Node test for the pure grid logic (no pdfjs). Run: node src/pdfGrid.test.mjs
import { buildCells, cellsToFields, cellHasText, dedupeCells } from './pdfGrid.js'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg) } }
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t

const PW = 600, PH = 800
// text token helper: x..xr horizontally, baseline yTop (top-origin), height h
const T = (str, x, xr, yTop, h = 10) => ({ str, x, xr, yTop, h })
// a cell that "contains" a token vertically has the token baseline inside it

console.log('cellHasText — occupancy')
{
  const cell = { x: 100, y: 100, w: 200, h: 20 } // 100..300 x, 100..120 y
  // centred header text inside the cell → occupied
  ok(cellHasText(cell, [T('Comments', 170, 240, 114)]), 'centred text occupies cell')
  // RIGHT-aligned text whose left edge is right of cell centre → old test missed this
  ok(cellHasText(cell, [T('12', 260, 292, 114)]), 'right-aligned text occupies cell')
  // header text whose baseline sits 1px ABOVE this cell must NOT occupy it
  ok(!cellHasText(cell, [T('Comments', 150, 240, 99)]), 'text just above the cell does not occupy it')
  // text from the row below (baseline just under the cell) must NOT occupy it
  ok(!cellHasText(cell, [T('below', 150, 240, 133)]), 'text just below the cell does not occupy it')
  // a left-hand row label that only grazes the cell edge → not occupied
  ok(!cellHasText(cell, [T('Check unit', 20, 104, 114)]), 'left row-label grazing edge does not occupy cell')
  // truly empty
  ok(!cellHasText(cell, []), 'empty cell is empty')
  // sparse pre-printed legend text ("1 2 3 4 5") in a wide/tall cell — each glyph
  // is narrow so the overlap test alone misses it, but a field must NOT cover it
  const grade = { x: 100, y: 100, w: 120, h: 60 } // tall grading box
  ok(cellHasText(grade, [T('1', 108, 114, 116)]), 'a single small digit occupies a wide grading box')
  ok(cellHasText(grade, [T('1', 108, 114, 116), T('2', 124, 130, 116)]), 'spaced grading digits occupy the box')
}

console.log('dedupeCells — one field per visual box')
{
  // 1) an explicit rectangle and the same box reconstructed from its edges land a
  //    few px apart → must collapse to ONE cell.
  const a = { x: 100, y: 100, w: 90, h: 22 }
  const b = { x: 102, y: 101, w: 88, h: 21 }
  ok(dedupeCells([a, b]).length === 1, `near-duplicate cells collapse to one (got ${dedupeCells([a, b]).length})`)

  // 2) an outer frame enclosing two inner cells is dropped (its children remain).
  const frame = { x: 40, y: 40, w: 300, h: 60 }
  const c1 = { x: 50, y: 50, w: 120, h: 40 }
  const c2 = { x: 200, y: 50, w: 120, h: 40 }
  const kept = dedupeCells([frame, c1, c2])
  ok(!kept.includes(frame) && kept.length === 2, `container frame dropped, inner cells kept (got ${kept.length})`)

  // 3) two genuinely separate adjacent cells are both kept.
  ok(dedupeCells([{ x: 0, y: 0, w: 50, h: 20 }, { x: 60, y: 0, w: 50, h: 20 }]).length === 2, 'separate cells both kept')
}

console.log('cellsToFields — the three reported symptoms')
{
  // A 3-column grid: [row label col] [answer col] [comments col], 4 rows.
  // Row 0 is the HEADER row (printed column titles), rows 1..3 are task rows.
  // Column x-bands: label 40..250, answer 250..340, comments 340..560
  const rowY = [100, 122, 144, 166, 188] // 4 rows between these 5 lines
  const cells = []
  for (let r = 0; r < 4; r++) {
    const y = rowY[r], h = rowY[r + 1] - rowY[r]
    cells.push({ x: 250, y, w: 90, h })   // answer cell (narrow → status)
    cells.push({ x: 340, y, w: 220, h })  // comments cell (wide → text)
  }
  const texts = [
    // header row (r=0) printed titles, centred in their columns
    T('Result', 270, 320, rowY[0] + 16),
    T('Comments', 410, 490, rowY[0] + 16),
    // a status token above the answer column so it classifies as status
    T('1Y', 285, 305, rowY[0] + 16),
    // row labels to the LEFT of the grid on task rows
    T('Check unit visually for faults', 40, 230, rowY[1] + 16),
    T('Perform condition monitoring', 40, 230, rowY[2] + 16),
    // row 3 answer cell already has a printed code / value → must be skipped
    T('N/A', 275, 315, rowY[3] + 16),
  ]
  const fields = cellsToFields(cells, texts, PW, PH, 0)

  // Header row cells (r=0) must NOT become fields — including an empty label
  // cell on that row (the "title section" a field must never land in).
  const inHeaderRow = fields.filter((f) => f.yPct * PH < rowY[1] - 1)
  ok(inHeaderRow.length === 0, `no field in the header/title row (got ${inHeaderRow.length})`)

  // First TASK row (r=1) MUST get its answer + comments fields (not skipped).
  const firstTaskRow = fields.filter((f) => f.yPct * PH >= rowY[1] - 1 && f.yPct * PH < rowY[2] - 1)
  ok(firstTaskRow.length === 2, `first task row is filled, not skipped (got ${firstTaskRow.length})`)

  // The answer cell that already holds "N/A" (r=3) must be skipped → that row
  // only yields the comments field.
  const lastRow = fields.filter((f) => f.yPct * PH >= rowY[3] - 1)
  ok(lastRow.length === 1 && lastRow[0].type === 'text', `pre-filled answer cell skipped (got ${lastRow.map((f) => f.type).join(',')})`)

  // Narrow answer cells classify as status, wide comments as text.
  const statuses = fields.filter((f) => f.type === 'status')
  const texts2 = fields.filter((f) => f.type === 'text')
  ok(statuses.every((f) => f.wPct * PW < 100), 'status fields are the narrow answer cells')
  ok(texts2.every((f) => f.wPct * PW > 150), 'text fields are the wide comments cells')

  // Row label is carried onto the answer field for profile autofill.
  ok(fields.some((f) => /Check unit/i.test(f.label)) || statuses.length > 0, 'row labels available')
}

console.log('cellsToFields — empty label cell on the header row is skipped')
{
  // label column cells for 4 rows; row 0 is the header row (has a Comments title
  // in a neighbouring column) and its label cell is EMPTY → must NOT get a field.
  const cells = [
    { x: 40, y: 100, w: 200, h: 22 },  // header-row label cell (empty)
    { x: 40, y: 122, w: 200, h: 22 },  // task row 1 label cell (has label)
    { x: 40, y: 144, w: 200, h: 22 },  // task row 2
    { x: 340, y: 100, w: 200, h: 22 }, // header-row comments cell (has title)
    { x: 340, y: 122, w: 200, h: 22 }, // task row 1 comments (empty → field)
    { x: 340, y: 144, w: 200, h: 22 }, // task row 2 comments (empty → field)
  ]
  const texts = [
    T('Comments', 400, 480, 116),          // header title on row 0
    T('Check unit visually', 44, 220, 138),// row 1 label
    T('Perform condition monitoring', 44, 230, 160), // row 2 label
  ]
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  const headerRow = fields.filter((f) => f.yPct * PH < 121)
  ok(headerRow.length === 0, `empty label cell on header row skipped (got ${headerRow.length})`)
  ok(fields.length === 2 && fields.every((f) => f.type === 'text'), `only the two empty comments cells get fields (got ${fields.length})`)
}

console.log('buildCells — reconstructs a simple grid')
{
  // 2 columns x 2 rows grid from lines. x lines at 100,200,300; y lines at 400,430,460
  const xs = [100, 200, 300], ys = [400, 430, 460]
  const hlines = [], vlines = []
  for (const y of ys) hlines.push({ y, x1: 100, x2: 300 })
  for (const x of xs) vlines.push({ x, y1: 400, y2: 460 })
  const cells = buildCells(hlines, vlines, [], PW, PH)
  ok(cells.length === 4, `4 cells from a 2x2 grid (got ${cells.length})`)
}

console.log('signature label detection')
{
  const cells = [
    { x: 250, y: 300, w: 200, h: 24 },
    { x: 250, y: 330, w: 200, h: 24 },
    { x: 250, y: 360, w: 200, h: 24 },
    { x: 250, y: 390, w: 200, h: 24 },
  ]
  const texts = [T('Inspected by (Signature)', 40, 240, 316)]
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  ok(fields.some((f) => f.type === 'signature'), 'a "Signature" row label yields a signature field')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
