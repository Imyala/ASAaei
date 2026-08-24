import * as pdfjsLib from 'pdfjs-dist'
// Inline the worker into the bundle (?worker&inline) so the app is fully
// self-contained — no separate worker file to fetch. Works in the normal build
// and when bundled to a single HTML file.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'

// ---------------------------------------------------------------------------
// Progressive page rendering
// ---------------------------------------------------------------------------
// This used to render every page to a PNG data URL and return only when the
// whole document was done. On a 37-page procedure that was ~9 s during which
// the app showed nothing, and it left 6.6 MB of base64 strings sitting in React
// state — on an 80-page document, closer to 15 MB, which is a lot to ask of an
// iPad.
//
// Now the geometry of every page comes back immediately (it needs no
// rasterising), so the document can be laid out and filled straight away, and
// the images arrive one at a time behind it. Each is a JPEG object URL: far
// quicker to encode than PNG, and a handle rather than megabytes of string.
//
// Object URLs are not garbage collected on their own — whoever holds these
// pages must call `revokePageImages` when done with them.

const JPEG_QUALITY = 0.9

// Start rendering `bytes`. Resolves as soon as page geometry is known; the
// images keep arriving through `onPage(index, { src })` afterwards.
//
// Returns { sizes, done, prioritise, cancel }:
//   sizes       — one entry per page, ready to lay out now
//   done        — resolves when every page image has been rendered
//   prioritise  — render the page nearest this index next (follows the scroll)
//   cancel      — stop rendering and release everything
export async function startPdfRender(bytes, { scale = 1.5, onPage } = {}) {
  const worker = new pdfjsLib.PDFWorker({ port: new PdfWorker() })
  // pdf.js detaches the buffer it is handed, and the original is needed later
  // for baking values in, so it gets a copy.
  const task = pdfjsLib.getDocument({ data: bytes.slice(), worker })

  let pdf
  try {
    pdf = await task.promise
  } catch (err) {
    task.destroy?.(); worker.destroy?.()
    throw err
  }

  // Geometry first — cheap, and enough to lay the document out.
  const sizes = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const view = page.getViewport({ scale })
    const unscaled = page.getViewport({ scale: 1 })
    sizes.push({
      src: null, // filled in as the image arrives
      pxWidth: Math.ceil(view.width),
      pxHeight: Math.ceil(view.height),
      ptWidth: unscaled.width,
      ptHeight: unscaled.height,
    })
  }

  let cancelled = false
  // The page the user is looking at. Rendering follows it, so jumping to page
  // 30 does not mean waiting for pages 1-29 to be drawn first.
  let focus = 0
  const pending = new Set(sizes.map((_, i) => i))

  const nextIndex = () => {
    let best = -1, bestDist = Infinity
    for (const i of pending) {
      const d = Math.abs(i - focus)
      // Ties go to the later page: when the user is at the top, that renders
      // downward, which is the direction they are about to scroll.
      if (d < bestDist || (d === bestDist && i > best)) { best = i; bestDist = d }
    }
    return best
  }

  const done = (async () => {
    try {
      while (pending.size && !cancelled) {
        const i = nextIndex()
        pending.delete(i)
        const size = sizes[i]
        try {
          const page = await pdf.getPage(i + 1)
          if (cancelled) break
          const canvas = document.createElement('canvas')
          canvas.width = size.pxWidth
          canvas.height = size.pxHeight
          const ctx = canvas.getContext('2d')
          // A PDF page has no background of its own; without this, any area the
          // page does not paint comes out transparent and JPEG renders it black.
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          await page.render({
            canvasContext: ctx,
            viewport: page.getViewport({ scale: size.pxWidth / size.ptWidth }),
          }).promise
          if (cancelled) break
          const src = await canvasToObjectUrl(canvas)
          if (cancelled) { URL.revokeObjectURL(src); break }
          onPage?.(i, { src })
        } catch (err) {
          // One unrenderable page must not cost the document the other 36.
          console.warn(`Could not render page ${i + 1}:`, err)
          onPage?.(i, { src: null, failed: true })
        }
        // Hand the main thread back between pages so typing and scrolling stay
        // responsive while the rest of the document draws behind the user.
        await new Promise((r) => setTimeout(r, 0))
      }
    } finally {
      task.destroy?.()
      worker.destroy?.()
    }
  })()

  return {
    sizes,
    done,
    prioritise(index) {
      if (Number.isFinite(index)) focus = index
    },
    cancel() {
      cancelled = true
      pending.clear()
    },
  }
}

// Release the object URLs held by a set of rendered pages.
export function revokePageImages(pages) {
  for (const p of pages || []) {
    if (p?.src) {
      try { URL.revokeObjectURL(p.src) } catch { /* already gone */ }
    }
  }
}

// Encode a canvas to a JPEG object URL. `toBlob` keeps the encode off the
// base64 path — quicker, and the result is a handle instead of a string.
function canvasToObjectUrl(canvas) {
  return new Promise((resolve, reject) => {
    if (!canvas.toBlob) {
      // No toBlob (very old browser): fall back to a data URL.
      try { resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY)) } catch (err) { reject(err) }
      return
    }
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error('Page image encoding failed')); return }
        resolve(URL.createObjectURL(blob))
      },
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
}
