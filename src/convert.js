import mammoth from 'mammoth/mammoth.browser.js'
import html2canvas from 'html2canvas'
import { PDFDocument } from 'pdf-lib'
import { classifyHeader, norm } from './fieldClassify.js'
import { detectPdfFields, sniffPdfIdentity } from './pdfFields.js'
import { extractIdentity } from './docId.js'

// A4 in CSS pixels (~96 dpi) and in PDF points.
const A4_W_PX = 794
const A4_H_PX = 1123
const A4_W_PT = 595.28
const A4_H_PT = 841.89

// ---------------------------------------------------------------------------
// Auto field detection (Word docs)
// ---------------------------------------------------------------------------
// Word documents keep their real table structure, so before we flatten the doc
// to an image we walk every table and decide, cell by cell, what the tech is
// meant to fill in:
//   • status columns (OK/Fail/N/A, or maintenance frequencies 1M/3M/6M/1Y) ->
//     an OK/Fail/N/A dropdown
//   • Remarks / Comments columns and blank label→value cells -> a text field
// The blank cells become pre-placed fields so the tech just fills, no layout.
// (PDFs are handled separately in pdfFields.js.)

// Walk the laid-out document (`holder`) and return pre-placed field definitions.
// Coordinates are page-relative fractions, matching the field model used by the
// editor. `holder` is the same element we hand to html2canvas, so its geometry
// maps 1:1 onto the rendered PDF pages.
export function detectTableFields(holder) {
  const fields = []
  const holderBox = holder.getBoundingClientRect()
  const tables = holder.querySelectorAll('table')

  tables.forEach((table) => {
    const rows = Array.from(table.rows || [])
    if (rows.length < 1) return
    const colCount = Math.max(...rows.map((r) => r.cells.length))

    // Column roles from the first (header) row.
    const header = Array.from(rows[0].cells).map((c) => norm(c.textContent))
    const roles = []
    for (let c = 0; c < colCount; c++) roles[c] = classifyHeader(header[c] || '')

    // A "grid" inspection table has a recognised status/remarks column; a
    // simple label→value table (Site name | …) does not. In grids the first
    // column is the task description and is never a field; in label tables the
    // second column is the value the tech fills in.
    const isGrid = roles.some((r) => r === 'status') || colCount >= 3

    rows.forEach((row) => {
      const cells = Array.from(row.cells)
      const labelIdx = cells.findIndex((c) => norm(c.textContent).length > 0)
      const rowLabel = labelIdx >= 0 ? norm(cells[labelIdx].textContent) : ''

      cells.forEach((cell, ci) => {
        if (norm(cell.textContent).length > 0) return // already has content
        if (ci === labelIdx) return // the row's own label cell
        if (isGrid && ci === 0) return // task-description column stays blank

        // Role: header wins; otherwise default label→value blanks to text.
        let role = roles[ci]
        if (!role) role = isGrid ? '' : 'text'
        if (!role) return // unknown column in a grid -> leave alone

        const r = cell.getBoundingClientRect()
        const x = r.left - holderBox.left
        const y = r.top - holderBox.top
        if (r.width < 16 || r.height < 8) return // too small to be a field

        // Inset a touch so the control sits inside the cell borders.
        const pad = 2
        const page = Math.floor((y + r.height / 2) / A4_H_PX)
        const yInPage = y - page * A4_H_PX
        const field = {
          type: role === 'status' ? 'status' : 'text',
          page,
          xPct: clampPct((x + pad) / A4_W_PX),
          yPct: clampPct((yInPage + pad) / A4_H_PX),
          wPct: clampPct((r.width - pad * 2) / A4_W_PX),
          hPct: clampPct((r.height - pad * 2) / A4_H_PX),
          label: norm(header[ci]) || rowLabel || (role === 'status' ? 'Result' : 'Detail'),
          options: [],
          value: '',
          auto: true,
        }
        fields.push(field)
      })
    })
  })

  return fields
}

function clampPct(v) {
  if (!Number.isFinite(v)) return 0
  return Math.min(Math.max(v, 0), 1)
}

// Convert a .docx to clean, Word-like HTML with mammoth. Underline and
// strikethrough are kept (mammoth drops them by default) and empty paragraphs
// are preserved so vertical spacing tracks the original; bold/italic/headings/
// lists/tables/images come through with the default style map. This HTML is
// used both for the PDF fill pipeline and, directly, by the document editor.
export async function docxToHtml(arrayBuffer) {
  const { value } = await mammoth.convertToHtml(
    { arrayBuffer },
    { styleMap: ['u => u', 'strike => s'], ignoreEmptyParagraphs: false },
  )
  return value || ''
}

// Convert a .docx to PDF entirely in the browser (no server, works offline).
// The result is treated exactly like an uploaded PDF from then on, and the
// detected fields ride along as `autoFields`.
export async function docxToPdf(arrayBuffer, { onProgress } = {}) {
  const html = await docxToHtml(arrayBuffer)
  const identity = extractIdentity(htmlToText(html))
  const { bytes, autoFields } = await htmlToPdf(html, { onProgress, detectFields: true })
  return { bytes, autoFields, ...identity }
}

// Lay an HTML string out at A4 width, rasterise with html2canvas, slice into
// A4 pages, and assemble a PDF with pdf-lib. Shared by the Word→PDF fill path
// (`detectFields: true` measures the fillable table cells off the live layout
// and returns them as page-relative `autoFields`) and the document editor's
// "export to PDF" (`detectFields: false`). Uses the same DOCX_CSS as the
// on-screen editor, so the exported PDF matches what the user was editing.
export async function htmlToPdf(html, { onProgress, detectFields = false } = {}) {
  const holder = document.createElement('div')
  holder.className = 'docx-holder'
  Object.assign(holder.style, {
    // Must be within the viewport so html2canvas can capture it.
    // z-index: -9999 keeps it behind the app UI; pointer-events: none
    // prevents accidental interaction during the async conversion.
    position: 'fixed', left: '0', top: '0',
    zIndex: '-9999', pointerEvents: 'none',
    width: A4_W_PX + 'px', padding: '56px', boxSizing: 'border-box',
    background: '#ffffff', color: '#000',
    font: '14px "Segoe UI", Calibri, system-ui, -apple-system, sans-serif', lineHeight: '1.4',
  })
  // Rich, Word-like styling for the converted HTML. mammoth produces clean but
  // *unstyled* markup — no table borders, no heading sizing, no list markers —
  // so an inspection grid would otherwise render as a borderless wall of text
  // and "lose the original format". This scoped stylesheet restores the look of
  // a printed form: ruled table grids, spaced headings, real lists. It lives
  // inside the holder, so it is removed with it and never leaks into the app.
  const style = document.createElement('style')
  style.textContent = DOCX_CSS
  holder.appendChild(style)
  const body = document.createElement('div')
  body.innerHTML = html || '<p></p>'
  holder.appendChild(body)
  document.body.appendChild(holder)

  try {
    // Wait for webfonts and embedded images to finish loading so nothing is
    // captured before it can paint (a first-paint capture would otherwise
    // catch invisible text or half-loaded pictures).
    await waitForAssets(holder)

    // Measure fillable cells before rasterising (needs a live layout).
    const autoFields = detectFields ? detectTableFields(holder) : []

    const fullHeight = Math.max(holder.scrollHeight, A4_H_PX)
    const pageCount = Math.max(1, Math.ceil(fullHeight / A4_H_PX))
    const scale = 2

    // Render the document in chunks of a few pages instead of one giant image.
    //   • One canvas for the whole document overflows the browser's maximum
    //     canvas size — ~16384px per side on desktop and a ~16.7M-pixel *area*
    //     cap on mobile Safari/iOS — and silently comes back blank, so every
    //     page lost its content.
    //   • One html2canvas call *per page* is safe but re-clones and re-lays-out
    //     the entire document on every call, so a long inspection procedure
    //     (dozens of pages) took O(n²) time and appeared to hang.
    // Chunking gets both right: each chunk stays well under the canvas limits,
    // and the whole document renders in only a handful of passes. Pick the
    // chunk size from those limits so it holds for any page count.
    const pageDevW = A4_W_PX * scale
    const pageDevH = A4_H_PX * scale
    // Mobile Safari/iOS caps a canvas at ~16.7M pixels of *area*; desktop
    // browsers allow a far larger area but cap each *side* at ~16384px. Use a
    // conservative area budget only where it actually binds so desktop can pack
    // more pages per pass (fewer, faster renders) without risking a blank
    // canvas on iOS.
    const MAX_CANVAS_SIDE = 16000 // px — desktop max canvas dimension
    const MAX_CANVAS_AREA = isMobileSafari() ? 12_000_000 : 200_000_000 // px²
    const pagesPerChunk = Math.max(
      1,
      Math.min(
        Math.floor(MAX_CANVAS_AREA / (pageDevW * pageDevH)),
        Math.floor(MAX_CANVAS_SIDE / pageDevH),
      ),
    )

    const pdfDoc = await PDFDocument.create()
    for (let first = 0; first < pageCount; first += pagesPerChunk) {
      const chunkPages = Math.min(pagesPerChunk, pageCount - first)
      // Report progress and yield to the event loop so the UI can repaint —
      // otherwise a long document looks frozen even though it is converting.
      if (onProgress) onProgress(first, pageCount)
      await new Promise((r) => setTimeout(r, 0))
      const chunkCanvas = await html2canvas(holder, {
        scale,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        width: A4_W_PX,
        height: chunkPages * A4_H_PX,
        x: 0,
        y: first * A4_H_PX,
        windowWidth: A4_W_PX,
        windowHeight: fullHeight,
        scrollX: 0,
        scrollY: 0,
      })

      // Slice the chunk into individual A4 pages and add each to the PDF.
      for (let j = 0; j < chunkPages; j++) {
        const slice = document.createElement('canvas')
        slice.width = chunkCanvas.width
        slice.height = pageDevH
        const ctx = slice.getContext('2d')
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, slice.width, slice.height)
        // Clamp the source height so the final slice never reads past the
        // chunk canvas (html2canvas can round its output height by a pixel).
        const srcY = j * pageDevH
        const srcH = Math.min(pageDevH, chunkCanvas.height - srcY)
        if (srcH > 0) {
          ctx.drawImage(
            chunkCanvas,
            0, srcY, chunkCanvas.width, srcH,
            0, 0, chunkCanvas.width, srcH,
          )
        }

        // Embed each page as JPEG, not PNG. PNG-encoding a full-scale page
        // (~1588×2246 px) is a slow, blocking `toDataURL` call run once per
        // page and yields multi-megabyte pages, so a long document was slow to
        // build, slow to re-render, and slow to download. `toBlob(...,'jpeg')`
        // encodes far faster, off the base64 path, and produces a fraction of
        // the bytes — the pages are white-background rasters, so JPEG at high
        // quality is visually indistinguishable here.
        const jpg = await pdfDoc.embedJpg(await canvasToJpegBytes(slice, 0.92))
        const page = pdfDoc.addPage([A4_W_PT, A4_H_PT])
        // The slice matches A4's aspect ratio, so it fills the page 1:1.
        page.drawImage(jpg, { x: 0, y: 0, width: A4_W_PT, height: A4_H_PT })
      }
    }
    if (onProgress) onProgress(pageCount, pageCount)
    // Drop any field whose page fell outside the produced range (safety).
    const fields = autoFields.filter((f) => f.page >= 0 && f.page < pageCount)
    return { bytes: await pdfDoc.save(), autoFields: fields }
  } finally {
    document.body.removeChild(holder)
  }
}

// Encode a canvas to JPEG bytes via the async `toBlob` path (with a
// `toDataURL` fallback for the rare browser that lacks `toBlob`). Returns a
// Uint8Array ready for pdf-lib's `embedJpg`. Async encoding keeps the main
// thread free so the conversion-progress UI can repaint between pages.
function canvasToJpegBytes(canvas, quality = 0.92) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error('Canvas JPEG encoding failed')); return }
          blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject)
        },
        'image/jpeg',
        quality,
      )
    } else {
      // Fallback: decode the data-URL's base64 payload to bytes.
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        resolve(bytes)
      } catch (err) { reject(err) }
    }
  })
}

// Word-like stylesheet applied to the HTML before rasterising, and reused by
// the on-screen document editor so editing is WYSIWYG with the exported PDF.
// Scoped to `.docx-holder`, the class carried by both the off-screen
// conversion element and the editor's page surface.
export const DOCX_CSS = `
.docx-holder, .docx-holder * { box-sizing: border-box; }
.docx-holder p { margin: 0 0 8px; }
.docx-holder h1, .docx-holder h2, .docx-holder h3,
.docx-holder h4, .docx-holder h5, .docx-holder h6 {
  margin: 14px 0 8px; line-height: 1.25; font-weight: 700;
}
.docx-holder h1 { font-size: 24px; }
.docx-holder h2 { font-size: 20px; }
.docx-holder h3 { font-size: 17px; }
.docx-holder h4 { font-size: 15px; }
.docx-holder h5, .docx-holder h6 { font-size: 14px; }
.docx-holder ul, .docx-holder ol { margin: 0 0 8px; padding-left: 26px; }
.docx-holder li { margin: 2px 0; }
.docx-holder a { color: #0563c1; text-decoration: underline; }
.docx-holder img { max-width: 100%; height: auto; }
/* Ruled grids — the defining look of an inspection form. mammoth drops every
   table border, so without this the checklist reads as unformatted text. */
.docx-holder table {
  border-collapse: collapse; width: 100%; margin: 8px 0;
  table-layout: fixed; word-wrap: break-word;
}
.docx-holder td, .docx-holder th {
  border: 1px solid #444; padding: 4px 6px;
  vertical-align: top; text-align: left;
}
.docx-holder th { background: #f0f0f0; font-weight: 700; }
`

// iOS/iPadOS Safari (and desktop Safari) enforce the tight per-canvas *area*
// limit that other browsers don't. iPadOS reports a desktop "Macintosh" UA, so
// also treat a touch-capable Mac as mobile Safari.
function isMobileSafari() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const iOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document)
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Android/.test(ua)
  return iOS || safari
}

// Wait for fonts and any embedded images inside `el` to load before we
// rasterise, capped so a stuck asset can never hang the conversion.
async function waitForAssets(el, timeoutMs = 8000) {
  const waits = []
  if (document.fonts && document.fonts.ready) waits.push(document.fonts.ready)
  const imgs = Array.from(el.querySelectorAll('img'))
  for (const img of imgs) {
    if (img.complete) continue
    waits.push(new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
    }))
  }
  if (!waits.length) return
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs))
  try { await Promise.race([Promise.all(waits), timeout]) } catch { /* best-effort */ }
}

// Strip HTML to plain text (with line breaks) for identity sniffing.
function htmlToText(html) {
  const el = document.createElement('div')
  el.innerHTML = (html || '').replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
  return el.textContent || ''
}

// Route any uploaded file to PDF bytes, auto-detected fields, and identity.
// • .docx  -> converted here, fields read from the Word table structure.
// • .pdf   -> passed through; fields read from the PDF (AcroForm or text grid).
export async function fileToPdfBytes(file, { onProgress } = {}) {
  const buf = await file.arrayBuffer()
  if (/\.pdf$/i.test(file.name)) {
    const bytes = new Uint8Array(buf)
    const [autoFields, identity] = await Promise.all([
      detectPdfFields(bytes).catch((err) => { console.warn('PDF field auto-detection failed:', err); return [] }),
      sniffPdfIdentity(bytes).catch(() => extractIdentity('', file.name)),
    ])
    // Fall back to the filename for the title if the PDF text gave us nothing.
    if (!identity.docTitle) identity.docTitle = file.name.replace(/\.pdf$/i, '')
    return { bytes, autoFields, ...identity }
  }
  if (/\.docx$/i.test(file.name)) return await docxToPdf(buf, { onProgress })
  throw new Error('Unsupported file type. Please use a PDF or Word (.docx) file.')
}
