#!/usr/bin/env node
// Run the app's ruled-box field detection over a PDF on disk and print what it
// finds, page by page — the way to check detection against a real converted
// document without opening the app.
//
//   node scripts/inspect-pdf.mjs form.pdf            # fields per page
//   node scripts/inspect-pdf.mjs form.pdf --raw 3    # + raw rects/lines/text on page 3
import { readFileSync } from 'node:fs'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { buildCells, detectPageFields, inheritColumnKinds } from '../src/pdfGrid.js'
import { collectGeometry, textTokens } from '../src/pdfGeometry.js'

const file = process.argv[2]
if (!file) { console.error('usage: inspect-pdf.mjs <file.pdf> [--raw <page>]'); process.exit(2) }
const rawPage = process.argv.includes('--raw') ? Number(process.argv[process.argv.indexOf('--raw') + 1]) : 0

const r = (n) => Math.round(n * 10) / 10
const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(readFileSync(file)), disableWorker: true }).promise
// Every page first, then the columns a table carries from page to page
// (inheritColumnKinds), as the app does; then the report.
const report = []
for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p)
  const vp = page.getViewport({ scale: 1 })
  const toVP = (x, y) => vp.convertToViewportPoint(x, y)
  const [opList, textContent] = await Promise.all([page.getOperatorList(), page.getTextContent()])
  const geo = collectGeometry(opList, toVP, pdfjsLib)
  const texts = textTokens(textContent.items, toVP)
  const cells = buildCells(geo.hlines, geo.vlines, geo.rects, vp.width, vp.height, texts)
  const fields = detectPageFields({ cells, texts, hlines: geo.hlines, pw: vp.width, ph: vp.height, pageIndex: p - 1, images: geo.images })
  report.push({ p, vp, geo, cells, texts, fields })
}
const all = inheritColumnKinds(report.flatMap((x) => x.fields))
for (const { p, vp, geo, cells, texts } of report) {
  const fields = all.filter((f) => f.page === p - 1)
  console.log(`\n=== page ${p}  ${r(vp.width)}x${r(vp.height)}  rects=${geo.rects.length} h=${geo.hlines.length} v=${geo.vlines.length} cells=${cells.length} fields=${fields.length}`)
  for (const f of fields) {
    const kind = f.options?.length ? ` [${f.options.join('/')}]` : ''
    console.log(`  ${f.type.padEnd(9)} x=${r(f.xPct * vp.width).toString().padStart(6)} y=${r(f.yPct * vp.height).toString().padStart(6)} w=${r(f.wPct * vp.width).toString().padStart(6)} h=${r(f.hPct * vp.height).toString().padStart(5)}  ${JSON.stringify(f.label)}${kind}`)
  }
  if (rawPage === p) {
    console.log('--- rects'); for (const c of geo.rects) console.log('  ', c.x.toFixed(1), c.y.toFixed(1), c.w.toFixed(1), c.h.toFixed(1))
    console.log('--- cells'); for (const c of cells) console.log('  ', c.x.toFixed(1), c.y.toFixed(1), c.w.toFixed(1), c.h.toFixed(1))
    console.log('--- hlines'); for (const l of geo.hlines) console.log('  y', l.y.toFixed(1), l.x1.toFixed(1), '→', l.x2.toFixed(1))
    console.log('--- text'); for (const t of texts) console.log('  ', t.x.toFixed(1), t.yTop.toFixed(1), t.xr.toFixed(1), t.h.toFixed(1), JSON.stringify(t.str))
  }
}
