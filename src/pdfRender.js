import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

// Render every page of a PDF to a PNG image plus its dimensions.
// We pass a *copy* of the bytes because pdf.js detaches the buffer it is given,
// and we need the original intact later for baking values back in.
export async function renderPdfToImages(bytes, scale = 1.5) {
  const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() })
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
}
