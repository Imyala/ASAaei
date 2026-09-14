import * as pdfjsLib from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { buildCells, detectPageFields } from './pdfGrid.js'
import { collectGeometry, textTokens } from './pdfGeometry.js'

// ---------------------------------------------------------------------------
// Ruled-box detection
// ---------------------------------------------------------------------------
// Official inspection forms draw their answer areas as real ruled boxes — table
// cell borders. Reading the *drawn geometry* (rectangles and horizontal/vertical
// lines) lets us drop a field exactly inside each empty box, so fields sit neatly
// in the cells and no box is missed — including grids with no text to anchor to
// (the "Unit Details" grid). Text positions are used only to (a) skip cells that
// already contain text and (b) label the columns (status vs text).
//
// The geometry readers live in pdfGeometry.js and the cell logic in pdfGrid.js,
// both free of pdf.js imports, so `scripts/inspect-pdf.mjs` can run the same
// detection over a real converted PDF in Node.

export async function detectPdfBoxes(bytes) {
  const worker = new pdfjsLib.PDFWorker({ port: new PdfWorker() })
  const task = pdfjsLib.getDocument({ data: bytes.slice(), worker })
  const fields = []
  try {
    const pdf = await task.promise
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      fields.push(...await detectPageBoxes(page, p - 1, pdfjsLib))
      // NOTE: no document-wide field cap here, deliberately. There used to be
      // one ("break once we pass 800"), and on a 37-page procedure it ran out
      // partway through page 25 — so the Appendix C inspection record on pages
      // 26-37, the part the tech actually fills in, opened with no boxes at all
      // and no indication anything was missing. `cellsToFields` bounds each
      // page on its own, which contains a pathological page without ever
      // costing the pages after it.
    }
    return fields
  } finally {
    task.destroy?.()
    worker.destroy?.()
  }
}

// The fields on one pdf.js page. `lib` is the pdf.js module in use (the
// worker-backed one in the app; the legacy build in the Node harness).
export async function detectPageBoxes(page, pageIndex, lib) {
  // Work in VIEWPORT space (scale 1). convertToViewportPoint folds in the
  // page's /Rotate, so geometry and text land in the same coordinate frame as
  // the rendered image for portrait AND rotated-landscape pages alike — page
  // fractions then overlay correctly whatever the rotation.
  const vp = page.getViewport({ scale: 1 })
  const { width: pw, height: ph } = vp
  const toVP = (x, y) => vp.convertToViewportPoint(x, y)
  const [opList, textContent] = await Promise.all([page.getOperatorList(), page.getTextContent()])
  const { hlines, vlines, rects, images } = collectGeometry(opList, toVP, lib)
  const cells = buildCells(hlines, vlines, rects, pw, ph)
  const texts = textTokens(textContent.items, toVP)
  return detectPageFields({ cells, texts, hlines, pw, ph, pageIndex, images })
}
