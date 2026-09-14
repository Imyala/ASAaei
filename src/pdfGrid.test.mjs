// Node test for the pure grid logic (no pdfjs). Run: node src/pdfGrid.test.mjs
import { buildCells, cellsToFields, cellHasText, dedupeCells, detectPageFields, blankLineFields, runExtent } from './pdfGrid.js'

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

console.log('cellsToFields — things that are not boxes to write in')
{
  // A page needs a grid before any of this applies, so every case below sits
  // alongside three ordinary answer cells that must survive untouched.
  const filler = [
    { x: 60, y: 500, w: 200, h: 20 },
    { x: 60, y: 530, w: 200, h: 20 },
    { x: 60, y: 560, w: 200, h: 20 },
  ]
  const at = (fields, x, y) =>
    fields.some((f) => near(f.xPct * PW, x + 1.5, 0.01) && near(f.yPct * PH, y + 1.5, 0.01))

  // A framed company logo on a cover page. The frame is a rectangle with
  // nothing inside it but a picture, so by geometry alone it reads as an empty
  // cell — this is what put a fillable field on top of the logo of a real
  // procedure.
  const logo = { x: 400, y: 60, w: 145, h: 55 }
  ok(at(cellsToFields([logo, ...filler], [], PW, PH, 0), 400, 60),
    'a framed empty rectangle is a field when nothing is drawn in it')
  ok(!at(cellsToFields([logo, ...filler], [], PW, PH, 0, [{ x: 405, y: 64, w: 135, h: 47 }]), 400, 60),
    'a cell filled by a picture is not a field')

  // A small inline icon must not disqualify the answer box it sits beside.
  const big = { x: 100, y: 300, w: 300, h: 40 }
  ok(at(cellsToFields([big, ...filler], [], PW, PH, 0, [{ x: 95, y: 295, w: 20, h: 20 }]), 100, 300),
    'a small picture in the corner leaves the box alone')

  // A rule or spacer between two table borders is too short to hold a line of
  // type, so it is not something anyone can write in.
  ok(!at(cellsToFields([{ x: 60, y: 400, w: 480, h: 8 }, ...filler], [], PW, PH, 0), 60, 400),
    'a cell shorter than a line of type is not a field')
  ok(at(cellsToFields([{ x: 60, y: 400, w: 480, h: 18 }, ...filler], [], PW, PH, 0), 60, 400),
    'a normal single-line cell still is')

  // The ordinary cells are untouched throughout.
  ok(cellsToFields(filler, [], PW, PH, 0).length === 0, 'three cells alone are not a grid')
  ok(cellsToFields([...filler, { x: 60, y: 590, w: 200, h: 20 }], [], PW, PH, 0).length === 4,
    'four ordinary answer cells all keep their boxes')
}


console.log('a task that wraps onto a line reading "condition" is not a header row')
{
  // The generator procedure's B.2.9: "Check fuel pump rack operation and
  // condition" wraps so its second line is the single word "condition" — a
  // status *heading* word — and B.2.12 carries a "Note:" in its task text.
  // Matching those words anywhere on the row skipped both rows entirely.
  const xs = [50, 105, 285, 325, 365, 430], ws = [55, 180, 40, 40, 65, 115]
  const rows = [72, 94, 114, 142, 245] // header, B.2.9, B.2.10, B.2.12 (tall), end
  const cells = []
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < xs.length; c++) cells.push({ x: xs[c], y: rows[r], w: ws[c], h: rows[r + 1] - rows[r] })
  }
  const texts = [
    T('Clause No', 55, 100, 82), T('Task', 110, 133, 82), T('LUL', 290, 309, 82), T('LPL', 330, 349, 82),
    T('Result', 370, 403, 82), T('Remarks/Action', 435, 515, 82),
    T('B.2.9', 55, 76, 102), T('Check fuel pump rack operation and', 110, 256, 102), T('condition', 110, 147, 112),
    T('N/A', 290, 305, 102), T('N/A', 330, 345, 102),
    T('B.2.10', 55, 81, 121), T('Check condition of all engine couplings,', 110, 270, 121), T('where applicable', 110, 178, 131),
    T('N/A', 290, 305, 121), T('N/A', 330, 345, 121),
    T('B.2.12', 55, 81, 150), T('Where applicable check condition and', 110, 263, 150),
    T('operation of cooling tower components.', 110, 270, 160), T('Note:', 110, 135, 170),
    T('1. Cooling towers require to be inspected', 110, 275, 180), T('2. This only applies to gensets cooled by', 110, 273, 190),
    T('N/A', 290, 305, 150), T('N/A', 330, 345, 150),
  ]
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  const rowOf = (y) => fields.filter((f) => Math.abs(f.yPct * PH - (y + 1.5)) < 1)
  ok(rowOf(72).length === 0, 'the real header row gets nothing')
  ok(rowOf(94).length === 2, `B.2.9 gets its Result and Remarks boxes (got ${rowOf(94).length})`)
  ok(rowOf(114).length === 2, `B.2.10 gets its boxes (got ${rowOf(114).length})`)
  ok(rowOf(142).length === 2, `B.2.12, with its "Note:", gets its boxes (got ${rowOf(142).length})`)
  ok(rowOf(94).some((f) => f.type === 'status') && rowOf(94).some((f) => f.type === 'text'), 'Result is a tap-cell, Remarks a text box')
  const remarks = rowOf(114).find((f) => f.type === 'text')
  ok(remarks && /^B\.2\.10 Check condition of all engine/.test(remarks.label),
    `the placeholder starts at the start of the row's label (got ${remarks && remarks.label})`)
  ok(remarks && !/N\/A/.test(remarks.label), 'the LUL/LPL values are not part of the label')
}

console.log('a shading band drawn across a row does not swallow its cells')
{
  // Word paints the grey of a shaded row as ONE rectangle across the whole
  // row. It used to count as the cell, its real cells were dropped inside it,
  // and — holding the row label — it got no field: every second row of the
  // performance test run table was missing.
  const cells = []
  const band = { x: 50, y: 100, w: 400, h: 15 } // the shading across row 1
  for (let r = 0; r < 4; r++) {
    cells.push({ x: 50, y: 100 + r * 15, w: 100, h: 15 })
    for (let c = 0; c < 6; c++) cells.push({ x: 150 + c * 50, y: 100 + r * 15, w: 50, h: 15 })
  }
  const kept = dedupeCells([band, ...cells])
  ok(!kept.some((c) => c.w === 400), 'the band itself is dropped')
  ok(kept.length === 28, `all 28 cells survive (got ${kept.length})`)
  // and a column band likewise
  const col = { x: 150, y: 100, w: 50, h: 60 }
  const kept2 = dedupeCells([col, ...cells])
  ok(!kept2.some((c) => c.h === 60) && kept2.length === 28, `a shaded column keeps its cells (got ${kept2.length})`)
  // ...while a cell with two small placeholders inside it is still one cell
  const cell = { x: 300, y: 100, w: 18, h: 28 }
  const ph1 = { x: 302, y: 101, w: 13, h: 14 }, ph2 = { x: 302, y: 118, w: 13, h: 8 }
  const sibs = [{ x: 300, y: 130, w: 18, h: 28 }, { x: 300, y: 160, w: 18, h: 28 }]
  const kept3 = dedupeCells([cell, ph1, ph2, ...sibs])
  ok(kept3.length === 3 && kept3.some((c) => c.h === 28 && c.y === 100), 'nested placeholders still collapse to the outer cell')
}

console.log('rows that ask for a reading are typed, not tapped')
{
  // Table D.4: twelve narrow columns against "Voltage (R): Volts", "RPM",
  // "Oil Press. Main: kPa" — figures, so the boxes must take typing.
  const labels = ['Time', 'Load (kW):', 'Voltage (R): Volts', 'RPM', 'Oil Press. Main: kPa', 'Cyl 1 Exhaust Temp: °C']
  const cells = [], texts = []
  labels.forEach((l, r) => {
    cells.push({ x: 50, y: 100 + r * 15, w: 110, h: 15 })
    texts.push(T(l, 54, 150, 111 + r * 15, 8))
    for (let c = 0; c < 12; c++) cells.push({ x: 160 + c * 28, y: 100 + r * 15, w: 28, h: 15 })
  })
  const fields = cellsToFields(cells, texts, PW, PH, 0)
  ok(fields.length === 72, `every reading cell gets a box (got ${fields.length})`)
  ok(fields.every((f) => f.type === 'text'), 'and every one is a text box')
  ok(fields.some((f) => f.label === 'Voltage (R): Volts'), 'labelled with the row it belongs to')

  // A "Grading (1-5)" / "Actual Reading" / "Pass/Fail" trio of narrow columns.
  const heads = ['Condition', 'Excellent', 'Grading (1-5)', 'Actual Reading', 'Pass/Fail']
  const xs = [50, 110, 400, 450, 500], ws = [60, 290, 50, 50, 50]
  const cells2 = [], texts2 = []
  for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) cells2.push({ x: xs[c], y: 100 + r * 40, w: ws[c], h: 40 })
  heads.forEach((h, c) => texts2.push(T(h, xs[c] + 4, xs[c] + 40, 112, 8)))
  texts2.push(T('Genset Visual', 54, 100, 152, 8), T('Condition', 54, 96, 162, 8), T('as new', 114, 160, 152, 8))
  texts2.push(T('Thermographic', 54, 105, 192, 8), T('no hot spots', 114, 170, 192, 8))
  const fields2 = cellsToFields(cells2, texts2, PW, PH, 0)
  ok(fields2.length === 6, `the three answer columns fill on both rows (got ${fields2.length})`)
  const grading = fields2.filter((f) => f.label === 'Grading (1-5)')
  ok(grading.length === 2 && grading.every((f) => f.type === 'text'), 'Grading is typed and carries its heading')
  ok(fields2.filter((f) => f.label === 'Actual Reading' && f.type === 'text').length === 2, 'so is Actual Reading')
  const pf = fields2.filter((f) => f.type === 'status')
  ok(pf.length === 2 && pf.every((f) => f.options[0] === 'Pass'), 'Pass/Fail stays a tap-cell with Pass/Fail wording')
  ok(fields2.every((f) => f.yPct * PH > 105), 'the "Condition" row-label heading does not make the data rows header rows')
}

console.log('a prompt printed in a cell gets a box beside it')
{
  // "Record water added" printed in the Remarks cell, "Start batteries:" /
  // "Control batteries:" in the Result cell: the printed words made the cell
  // read as full, so there was nowhere to type.
  const xs = [50, 105, 285, 325, 365, 430], ws = [55, 180, 40, 40, 65, 115]
  const cells = []
  for (const [y, h] of [[100, 20], [120, 60], [180, 20], [200, 20]]) {
    for (let c = 0; c < xs.length; c++) cells.push({ x: xs[c], y, w: ws[c], h })
  }
  const texts = [
    T('B.1.16', 55, 80, 112, 8), T('Check the alternator', 110, 200, 112, 8),
    T('B.1.17', 55, 80, 132, 8), T('Check electrolyte level', 110, 220, 132, 8),
    T('Start batteries:', 370, 425, 132, 8), T('Control batteries:', 370, 428, 160, 8),
    T('Record water added', 435, 500, 132, 8), T('Record water added', 435, 500, 160, 8),
    T('B.1.18', 55, 80, 192, 8), T('Check belts', 110, 160, 192, 8),
    T('B.1.19', 55, 80, 212, 8), T('Run engine', 110, 160, 212, 8),
  ]
  const fields = detectPageFields({ cells, texts, pw: PW, ph: PH, pageIndex: 0 })
  const prompts = fields.filter((f) => /Record water added|batteries/.test(f.label))
  ok(prompts.filter((f) => f.label === 'Record water added').length === 2, `both "Record water added" prompts get a box (got ${prompts.filter((f) => f.label === 'Record water added').length})`)
  ok(prompts.some((f) => f.label === 'Start batteries'), 'so does "Start batteries:"')
  ok(prompts.every((f) => f.type === 'text' && f.wPct * PW >= 40 && f.hPct * PH >= 8), 'each is a usable text box')
  ok(!fields.some((f) => /Check the alternator|Run engine/.test(f.label) && f.xPct * PW < 300),
    'a task description is not a prompt')
}

console.log('write-on lines get boxes')
{
  // Typed blanks: underscores/dots run into the label's own token or stand
  // alone after it ("Fuel start: ____Litres", "Genset:......").
  const texts = [
    T('Fuel start:', 50, 95, 356, 9), T('____Litres', 101, 144, 356, 9),
    T('Fuel finish:', 167, 215, 356, 9), T('____Litres', 221, 264, 356, 9),
    T('Remarks/Derating:_______________________________________', 50, 310, 367, 9),
    T('Genset:............................................................', 50, 256, 94, 9),
    T('Signature: ____________________', 50, 200, 420, 9),
    T('Fitted etc...', 50, 100, 500, 9), // an ellipsis in prose
  ]
  const fields = blankLineFields(texts, [], [], PW, PH, 0)
  const by = (l) => fields.filter((f) => f.label === l)
  ok(by('Fuel start').length === 1 && by('Fuel finish').length === 1, 'each fuel blank is labelled by the words before it')
  const fs = by('Fuel start')[0]
  ok(fs && fs.xPct * PW >= 100 && fs.xPct * PW <= 104, `the box starts where the underscores do (got ${fs && (fs.xPct * PW).toFixed(1)})`)
  ok(fs && fs.wPct * PW < 30, 'and stops before "Litres"')
  const rd = by('Remarks/Derating')[0]
  ok(rd && rd.xPct * PW > 100 && rd.xPct * PW + rd.wPct * PW <= 311, `a blank inside a token is placed after its label (got x=${rd && (rd.xPct * PW).toFixed(1)})`)
  ok(by('Genset').length === 1, 'a dotted leader is a blank too')
  ok(by('Signature').length === 1 && by('Signature')[0].type === 'signature', 'a signature line is a signature field')
  ok(!fields.some((f) => f.yPct * PH > 480), 'an ellipsis in prose is not a blank')

  // Drawn rules: a "Notes/Remarks:" caption over rows of dashes / a dashed
  // border, and a footer rule with no label near it.
  const texts2 = [
    T('Notes/Remarks:', 50, 140, 377, 10),
    T('AEI 3.3301', 50, 99, 815, 9),
    T('Primary and Standby Generators', 200, 400, 33, 9),
  ]
  const hlines = [
    { y: 390, x1: 50, x2: 545 }, { y: 403, x1: 50, x2: 545 }, { y: 416, x1: 50, x2: 545 },
    { y: 803, x1: 50, x2: 545 }, // footer rule
    { y: 36, x1: 50, x2: 545 },  // header rule, text sits on it
    { y: 500, x1: 50, x2: 250 }, { y: 520, x1: 50, x2: 250 }, // table edges
  ]
  const cells = [{ x: 50, y: 500, w: 200, h: 20 }]
  const fields2 = blankLineFields(texts2, hlines, cells, PW, PH, 0)
  ok(fields2.length === 3, `the three lines under "Notes/Remarks:" get boxes and nothing else does (got ${fields2.length}: ${fields2.map((f) => f.label + '@' + (f.yPct * PH).toFixed(0)).join(', ')})`)
  ok(fields2.every((f) => f.label === 'Notes/Remarks'), 'all carry the caption')
  ok(fields2.every((f) => f.hPct * PH >= 8 && f.hPct * PH <= 13), 'each box is a line of type tall')
}

console.log('runExtent — where a run sits along its token')
{
  const [x1, x2] = runExtent('Fuel:____', 5, 9, 0, 100)
  ok(x1 > 40 && x2 === 100, `the underscores end where the token ends (got ${x1.toFixed(1)}..${x2.toFixed(1)})`)
  const [a1, a2] = runExtent('____Litres', 0, 4, 100, 143)
  ok(a1 === 100 && a2 < 125, `leading underscores start at the token's left edge (got ${a1}..${a2.toFixed(1)})`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
