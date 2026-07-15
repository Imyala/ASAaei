import mammoth from 'mammoth/mammoth.browser.js'
import html2canvas from 'html2canvas'
import { PDFDocument } from 'pdf-lib'

// A4 in CSS pixels (~96 dpi) and in PDF points.
const A4_W_PX = 794
const A4_H_PX = 1123
const A4_W_PT = 595.28
const A4_H_PT = 841.89

// Convert a .docx to PDF entirely in the browser (no server, works offline).
// mammoth turns the document into HTML; we lay it out at A4 width, rasterise
// with html2canvas, slice into pages, and assemble a PDF with pdf-lib.
// The result is treated exactly like an uploaded PDF from then on.
export async function docxToPdf(arrayBuffer) {
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer })

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
    return await pdfDoc.save()
  } finally {
    document.body.removeChild(holder)
  }
}

// Route any uploaded file to PDF bytes. PDFs pass through untouched.
export async function fileToPdfBytes(file) {
  const buf = await file.arrayBuffer()
  if (/\.pdf$/i.test(file.name)) return new Uint8Array(buf)
  if (/\.docx$/i.test(file.name)) return await docxToPdf(buf)
  throw new Error('Unsupported file type. Please use a PDF or Word (.docx) file.')
}
