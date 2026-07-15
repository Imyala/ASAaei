import * as pdfjsLib from 'pdfjs-dist'
// Inline the worker into the bundle (?worker&inline) so the app is fully
// self-contained — no separate worker file to fetch. Works in the normal build
// and when bundled to a single HTML file.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'

// Render every page of a PDF to a PNG image plus its dimensions.
// We pass a *copy* of the bytes because pdf.js detaches the buffer it is given,
// and we need the original intact later for baking values back in.
// A fresh worker per call avoids reuse conflicts when a second document loads.
export async function renderPdfToImages(bytes, scale = 1.5) {
  const worker = new pdfjsLib.PDFWorker({ port: new PdfWorker() })
  const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(), worker })
  try {
    const pdf = await loadingTask.promise
    const pages = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise
      const unscaled = page.getViewport({ scale: 1 })
      pages.push({
        dataUrl: canvas.toDataURL('image/png'),
        pxWidth: canvas.width,
        pxHeight: canvas.height,
        ptWidth: unscaled.width,
        ptHeight: unscaled.height,
      })
    }
    return pages
  } finally {
    loadingTask.destroy?.()
    worker.destroy?.()
  }
}
