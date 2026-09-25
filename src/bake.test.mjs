// Node test for baking field values onto a PDF. Run: node --test src/bake.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { bakePdf, fitText, encodable, makeBlankPdf } from './bake.js'

test('a long entry wraps inside a tall box and shrinks in a short one', async () => {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const long = 'Replaced the fuel filter and bled the lines; no leaks found at the injector pump'
  const tall = fitText(long, font, 13, 140, 60)
  assert.ok(tall.lines.length > 1, 'wraps onto several lines')
  assert.ok(tall.lines.every((l) => font.widthOfTextAtSize(l, tall.size) <= 140), 'every line fits the width')
  assert.ok(tall.lines.length * tall.size * 1.15 <= 60, 'and the lines fit the height')
  const short = fitText('415.2', font, 13, 38, 14)
  assert.equal(short.lines.length, 1)
  assert.ok(font.widthOfTextAtSize('415.2', short.size) <= 38, 'a reading fits a narrow table cell')
})

test('characters the standard font lacks are spelled out, not fatal', async () => {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  assert.equal(encodable(font, 'OK 25 °C'), 'OK 25 °C')
  assert.equal(encodable(font, '✓ ≤ 5 Ω'), 'v <= 5 Ohm')
  assert.equal(encodable(font, 'done 👍'), 'done ?')
})

test('a document with every kind of value bakes', async () => {
  const bytes = await makeBlankPdf()
  const fields = [
    { type: 'text', page: 0, xPct: 0.1, yPct: 0.1, wPct: 0.06, hPct: 0.02, value: '415.2 ✓' },
    { type: 'text', page: 0, xPct: 0.1, yPct: 0.2, wPct: 0.3, hPct: 0.08, value: 'A long remark that has to wrap onto more than one line of the box' },
    { type: 'status', page: 0, xPct: 0.5, yPct: 0.1, wPct: 0.03, hPct: 0.015, value: 'Fail' },
    { type: 'status', page: 0, xPct: 0.5, yPct: 0.2, wPct: 0.05, hPct: 0.02, value: 'OK', covers: true },
    { type: 'status', page: 0, xPct: 0.6, yPct: 0.2, wPct: 0.015, hPct: 0.011, value: '✓', options: ['✓', '✗'], covers: true },
    { type: 'status', page: 0, xPct: 0.65, yPct: 0.2, wPct: 0.015, hPct: 0.011, value: '✗', options: ['✓', '✗'], covers: true },
    { type: 'mark', page: 0, xPct: 0.3, yPct: 0.7, wPct: 0.032, hPct: 0.022, value: '✓' },
    { type: 'mark', page: 0, xPct: 0.4, yPct: 0.7, wPct: 0.032, hPct: 0.022, value: '✗' },
    { type: 'signature', page: 0, xPct: 0.1, yPct: 0.5, wPct: 0.3, hPct: 0.06, value: { name: 'Jo Tech ✓', timestamp: '25 Sep 2026, 09:00' } },
  ]
  const out = await bakePdf(bytes, fields)
  const back = await PDFDocument.load(out)
  assert.equal(back.getPageCount(), 1)
})
