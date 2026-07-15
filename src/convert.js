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

// Convert a .docx to PDF entirely in the browser (no server, works offline).
// mammoth turns the document into HTML; we lay it out at A4 width, detect the
// fillable table cells, rasterise with html2canvas, slice into pages, and
// assemble a PDF with pdf-lib. The result is treated exactly like an uploaded
// PDF from then on, and the detected fields ride along as `autoFields`.
export async function docxToPdf(arrayBuffer) {
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer })
  const identity = extractIdentity(htmlToText(html))

  const holder = document.createElement('div')
  Object.assign(holder.style, {
    position: 'fixed', left: '-10000px', top: '0',
    width: A4_W_PX + 'px', padding: '56px', boxSizing: 'border-box',
    background: '#ffffff', color: '#000',
    font: '14px system-ui, -apple-system, "Segoe UI", sans-serif', lineHeight: '1.5',
  })
  holder.innerHTML = html || '<p></p>'
  document.body.appendChild(holder)

  try {
    // Measure fillable cells before rasterising (needs a live layout).
    const autoFields = detectTableFields(holder)

    const canvas = await html2canvas(holder, {
      scale: 2, backgroundColor: '#ffffff', windowWidth: A4_W_PX, useCORS: true,
    })
    const pxPerPage = A4_H_PX * (canvas.width / A4_W_PX) // page height in canvas px
    const pageCount = Math.max(1, Math.ceil(canvas.height / pxPerPage))

    const pdfDoc = await PDFDocument.create()
    for (let i = 0; i < pageCount; i++) {
      const sliceH = Math.min(pxPerPage, canvas.height - i * pxPerPage)
      const slice = document.createElement('canvas')
      slice.width = canvas.width
      slice.height = Math.round(sliceH)
      const ctx = slice.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, slice.width, slice.height)
      ctx.drawImage(canvas, 0, i * pxPerPage, canvas.width, sliceH, 0, 0, canvas.width, sliceH)

      const png = await pdfDoc.embedPng(slice.toDataURL('image/png'))
      const page = pdfDoc.addPage([A4_W_PT, A4_H_PT])
      const drawH = (slice.height / slice.width) * A4_W_PT
      page.drawImage(png, { x: 0, y: A4_H_PT - drawH, width: A4_W_PT, height: Math.min(drawH, A4_H_PT) })
    }
    // Drop any field whose page fell outside the produced range (safety).
    const fields = autoFields.filter((f) => f.page >= 0 && f.page < pageCount)
    return { bytes: await pdfDoc.save(), autoFields: fields, ...identity }
  } finally {
    document.body.removeChild(holder)
  }
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
export async function fileToPdfBytes(file) {
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
  if (/\.docx$/i.test(file.name)) return await docxToPdf(buf)
  throw new Error('Unsupported file type. Please use a PDF or Word (.docx) file.')
}
