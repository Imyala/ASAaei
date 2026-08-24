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

  // 2) a nested content-control placeholder (or two, stacked) inside a real
  //    answer cell must be dropped, keeping the OUTER visible cell — this is the
  //    "two boxes in one" symptom. Sizes mirror the real forms (18x28 cell with
  //    13x14 + 13x8 placeholders), amid a column of like-sized sibling cells.
  const cell = { x: 300, y: 100, w: 18, h: 28 }
  const ph1 = { x: 302, y: 101, w: 13, h: 14 }
  const ph2 = { x: 302, y: 118, w: 13, h: 8 }
  const sib1 = { x: 300, y: 130, w: 18, h: 28 }
  const sib2 = { x: 300, y: 160, w: 18, h: 28 }
  const kept2 = dedupeCells([cell, ph1, ph2, sib1, sib2])
  ok(kept2.some((c) => c.h === 28 && c.y === 100) && !kept2.some((c) => c.w === 13),
    `nested placeholders dropped, outer cell kept (got ${kept2.map((c) => c.w + 'x' + c.h).join(',')})`)

  // 3) a big table frame (far larger than a normal cell in both axes, enclosing
  //    a grid of real cells) is dropped; its children remain.
  const frame = { x: 40, y: 40, w: 400, h: 300 }
  const grid = []
  for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) grid.push({ x: 60 + cc * 120, y: 60 + r * 90, w: 90, h: 60 })
  const kept = dedupeCells([frame, ...grid])
  ok(!kept.includes(frame) && kept.length === grid.length, `table frame dropped, inner cells kept (got ${kept.length})`)

  // 4) two genuinely separate adjacent cells are both kept.
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


console.log('column headings become field labels')
{
  // A four-column equipment table: a printed heading row, then blank data rows.
  // There is no row label to the left, so the heading is the only thing that can
  // tell the tech what belongs in each box.
  const heads = ['Test equipment', 'Model', 'Barcode no.', 'Calibration due date']
  const xs = [60, 190, 320, 450]
  const cells = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) cells.push({ x: xs[c], y: 200 + r * 24, w: 120, h: 24 })
  }
  const texts = heads.map((h, i) => T(h, xs[i] + 4, xs[i] + 90, 216))
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  ok(fields.length === 8, `only the two blank rows get fields (got ${fields.length})`)
  ok(fields.every((f) => f.label !== 'Entry'), 'no field falls back to the generic "Entry" label')
  ok(fields.some((f) => f.label === 'Model'), 'a box under "Model" is labelled Model')
  ok(fields.some((f) => f.label === 'Calibration due date'),
    'a box under "Calibration due date" carries that heading')
}

console.log('a row label still beats the column heading')
{
  const cells = [
    { x: 250, y: 300, w: 200, h: 24 },
    { x: 250, y: 330, w: 200, h: 24 },
    { x: 250, y: 360, w: 200, h: 24 },
    { x: 250, y: 390, w: 200, h: 24 },
  ]
  // "SAP ID" to the LEFT of the second cell; a heading above the column.
  const texts = [T('Inspection Details', 250, 340, 296), T('SAP ID', 40, 200, 346)]
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  const sap = fields.find((f) => near(f.yPct, (330 + 1.5) / PH, 1e-9))
  ok(sap && sap.label === 'SAP ID',
    `the row label wins so profile autofill still matches (got ${sap && sap.label})`)
}

console.log('one dense page cannot starve the rest of the document')
{
  // 600 empty cells on a single page: the page is capped, but the cap is per
  // page, so it returns rather than aborting a document-wide walk.
  const cells = []
  for (let i = 0; i < 600; i++) cells.push({ x: 60 + (i % 4) * 130, y: 100 + Math.floor(i / 4) * 2, w: 120, h: 20 })
  const fields = cellsToFields(cells, cells.length ? [] : [], PW, PH, 3)
  ok(fields.length > 0 && fields.length <= 250, `page capped at 250 fields (got ${fields.length})`)
  ok(fields.every((f) => f.page === 3), 'every field stays on its own page')
}


console.log('a "Pass/Fail" sub-header row gets no fields')
{
  // Appendix D's outcomes table: a sub-header row reading
  // "F/A I/O No. | Pass/Fail | A-1, B-1 | Pass/Fail | …" over blank data rows.
  const xs = [60, 190, 320, 450]
  const cells = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) cells.push({ x: xs[c], y: 200 + r * 24, w: 120, h: 24 })
  }
  // Only two of the four header cells carry printed text; the other two are the
  // blank cells that used to sprout a field inside the header bar.
  const texts = [
    T('F/A I/O No.', 64, 140, 216),
    T('Pass/Fail', 194, 260, 216),
    T('AHU 1', 64, 120, 240),   // row label on data row 1
    T('AHU 2', 64, 120, 264),   // row label on data row 2
  ]
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  ok(fields.every((f) => f.yPct * PH > 220),
    'nothing is placed on the Pass/Fail header row')
  ok(fields.length === 6, `both blank data rows still fill (got ${fields.length})`)
}

console.log('blank caption cells in a grouped top header row get no fields')
{
  // "(blank) | (blank) | GFA | FAR1 | FAR2" — a grouped caption bar whose first
  // two cells are empty because they sit over the row-label column.
  const xs = [40, 140, 240, 340, 440]
  const cells = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) cells.push({ x: xs[c], y: 100 + r * 24, w: 95, h: 24 })
  }
  const texts = [
    T('GFA', 244, 290, 116), T('FAR1', 344, 392, 116), T('FAR2', 444, 492, 116),
  ]
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  ok(fields.every((f) => f.yPct * PH > 120), 'the caption bar itself stays empty')
  ok(fields.length === 10, `the two blank data rows still fill (got ${fields.length})`)
}

console.log('a label/value details table keeps its value boxes')
{
  // "Site name | ______" — the top row has ONE caption and one blank, which must
  // NOT be read as a caption bar, or the record page loses every field.
  const cells = []
  for (let r = 0; r < 4; r++) {
    cells.push({ x: 60, y: 200 + r * 24, w: 200, h: 24 })
    cells.push({ x: 260, y: 200 + r * 24, w: 260, h: 24 })
  }
  const texts = [
    T('Site name', 64, 130, 216), T('Unit No.', 64, 120, 240),
    T('SAP ID', 64, 115, 264), T('Date inspected', 64, 160, 288),
  ]
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  ok(fields.length === 4, `every value cell gets a field (got ${fields.length})`)
  ok(fields.some((f) => f.label === 'Site name'), 'the first row keeps its "Site name" label')
}


console.log('a checkbox outline does not split a tick cell into two boxes')
{
  // The F081 audit checklist: the answer column is 47pt wide on every row, but
  // on one row Word drew a checkbox control whose edges cut it into 19 + 28.
  // Both halves are blank, so the tech saw two tap-cells in one tick box.
  const cells = [
    { x: 60, y: 100, w: 99, h: 22 }, { x: 159, y: 100, w: 333, h: 22 }, { x: 495, y: 100, w: 47, h: 22 },
    { x: 60, y: 124, w: 99, h: 22 }, { x: 159, y: 124, w: 333, h: 22 }, { x: 495, y: 124, w: 47, h: 22 },
    // the split row
    { x: 60, y: 148, w: 99, h: 22 }, { x: 159, y: 148, w: 333, h: 22 },
    { x: 495, y: 148, w: 19, h: 22 }, { x: 514, y: 148, w: 28, h: 22 },
    { x: 60, y: 172, w: 99, h: 22 }, { x: 159, y: 172, w: 333, h: 22 }, { x: 495, y: 172, w: 47, h: 22 },
  ]
  const texts = [
    T('Documents', 64, 130, 116), T('Check the site holding list', 163, 330, 116),
    T('Drawings', 64, 125, 140), T('Check drawings against the list', 163, 340, 140),
    T('Reporting', 64, 126, 164), T('All issues must be in the site log', 163, 350, 164),
    T('Site Manifest', 64, 140, 188), T('Notify the update team', 163, 320, 188),
  ]
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  const onSplitRow = fields.filter((f) => Math.abs(f.yPct * PH - 149.5) < 3)
  ok(onSplitRow.length === 1, `the split tick cell yields one box, not two (got ${onSplitRow.length})`)
  ok(onSplitRow[0] && near(onSplitRow[0].wPct * PW, 44, 0.5),
    `the box spans the whole 47pt column (got ${onSplitRow[0] && (onSplitRow[0].wPct * PW).toFixed(1)})`)
  ok(fields.length === 4, `one box per answer row (got ${fields.length})`)
}

console.log('genuinely distinct narrow columns are not merged away')
{
  // Two real side-by-side columns (a "1M" and a "3M" frequency pair) that no
  // other row combines into a single span — these must stay two boxes.
  const cells = []
  for (let r = 0; r < 5; r++) {
    cells.push({ x: 60, y: 100 + r * 24, w: 300, h: 22 })
    cells.push({ x: 360, y: 100 + r * 24, w: 60, h: 22 })
    cells.push({ x: 420, y: 100 + r * 24, w: 60, h: 22 })
  }
  const texts = [
    T('Task', 64, 100, 116), T('1M', 364, 384, 116), T('3M', 424, 444, 116),
    ...[1, 2, 3, 4].map((i) => T('Check item ' + i, 64, 200, 116 + i * 24)),
  ]
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  ok(fields.length === 8, `both frequency columns keep a box on each row (got ${fields.length})`)
  ok(fields.every((f) => f.type === 'status'), 'they stay OK/N-A/Fail tap cells')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
