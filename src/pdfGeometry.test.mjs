// Node test for reading page geometry. Run: node --test src/pdfGeometry.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectGeometry, paragraphShading } from './pdfGeometry.js'
import { buildCells } from './pdfGrid.js'

const GREY = { 0: 217, 1: 217, 2: 217 }
const WHITE = { 0: 255, 1: 255, 2: 255 }

// An operator list as pdf.js produces it for Word's PDF export: the fill
// colour, then a rectangle path, then how it is painted. y is top-origin
// here and flipped into PDF user space (page 842 high) for the op list.
function opList(parts) {
  const fnArray = [], argsArray = []
  const op = (fn, args = null) => { fnArray.push(fn); argsArray.push(args) }
  for (const p of parts) {
    if (p.fill) op(OPS.setFillRGBColor, p.fill)
    if (p.rect) {
      const [x, y, w, h] = p.rect
      op(OPS.constructPath, [[OPS.rectangle], [x, 842 - y - h, w, h]])
      op(p.paint === 'clip' ? OPS.endPath : p.paint === 'stroke' ? OPS.stroke : OPS.eoFill)
    }
  }
  return { fnArray, argsArray }
}
const geometry = (parts) => collectGeometry(opList(parts), (x, y) => [x, 842 - y], { OPS, Util })

test('paragraph shading inside a shaded heading cell is not a table', () => {
  // The grey "Unit No" heading cell, the grey paragraph behind its text
  // inset 2.8pt each side, and the empty data cell under it.
  const geo = geometry([
    { fill: GREY, rect: [54.1, 339.1, 247.8, 31.3] },
    { fill: GREY, rect: [56.9, 339.1, 242.3, 18.6] },
    { fill: WHITE, rect: [54.1, 373.3, 247.8, 18.6] },
  ])
  assert.equal(geo.rects.length, 2, 'the paragraph rectangle is dropped')
  assert.ok(!geo.hlines.some((l) => Math.abs(l.y - 357.7) < 0.5), 'and so is its bottom edge')
  const cells = buildCells(geo.hlines, geo.vlines, geo.rects, 595, 842)
  assert.ok(!cells.some((c) => c.y > 350 && c.y < 360), 'no blank cell under the heading text')
})

test('a stack of shaded paragraphs in one cell all go', () => {
  // "Inspection" / "Type (e.g. 1M)": two lines, two paragraph rectangles.
  const rects = [
    { x: 451, y: 339.1, w: 85, h: 31.3 },
    { x: 453.7, y: 339.1, w: 79.5, h: 16.6 },
    { x: 453.7, y: 355.7, w: 79.5, h: 14.6 },
  ]
  assert.deepEqual([...paragraphShading(rects, ['grey', 'grey', 'grey'])].sort(), [1, 2])
})

test('a real box inside a panel stays', () => {
  const rects = [{ x: 50, y: 100, w: 300, h: 60 }, { x: 53, y: 110, w: 294, h: 20 }]
  // a white answer box on a grey panel: a different colour
  assert.equal(paragraphShading(rects, ['grey', 'white']).size, 0)
  // an outline drawn inside, not a fill
  assert.equal(paragraphShading(rects, ['grey', '']).size, 0)
  // off-centre: not a paragraph inset by the cell margins
  assert.equal(paragraphShading([rects[0], { x: 53, y: 110, w: 200, h: 20 }], ['grey', 'grey']).size, 0)
  // as tall as the cell: the cell's own shading, drawn twice
  assert.equal(paragraphShading([rects[0], { x: 53, y: 100, w: 294, h: 58 }], ['grey', 'grey']).size, 0)
})

test('a clipping rectangle is not a fill', () => {
  const geo = geometry([
    { fill: GREY, rect: [54.1, 339.1, 247.8, 31.3] },
    { fill: GREY, rect: [56.9, 339.1, 242.3, 18.6], paint: 'clip' },
  ])
  assert.equal(geo.rects.length, 2)
})
