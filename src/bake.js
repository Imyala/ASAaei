import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

// Draw all field values directly onto the PDF and return flattened bytes.
// "Flattened" = the values become part of the page content, so the result is a
// plain, non-editable PDF — this is what enforces "locked after signing".
export async function bakePdf(originalBytes, fields) {
  const pdfDoc = await PDFDocument.load(originalBytes)
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const pages = pdfDoc.getPages()

  for (const f of fields) {
    const page = pages[f.page]
    if (!page) continue
    const { width: pw, height: ph } = page.getSize()
    const x = f.xPct * pw
    const fw = f.wPct * pw
    const fh = f.hPct * ph
    const yBottom = ph - f.yPct * ph - fh // top-origin (screen) -> bottom-origin (PDF)

    if (f.type === 'text' || f.type === 'dropdown') {
      const value = String(f.value ?? '')
      if (!value) continue
      const size = Math.max(8, Math.min(13, fh * 0.6))
      page.drawText(value, {
        x: x + 2,
        y: yBottom + (fh - size) / 2,
        size,
        font,
        color: rgb(0, 0, 0),
      })
    } else if (f.type === 'status') {
      // Tri-state OK / Fail / N/A cell — draw the chosen value centred.
      const value = String(f.value ?? '')
      if (!value) continue
      const size = Math.max(8, Math.min(12, fh * 0.62))
      const tw = fontBold.widthOfTextAtSize(value, size)
      page.drawText(value, {
        x: x + Math.max(1, (fw - tw) / 2),
        y: yBottom + (fh - size) / 2,
        size,
        font: fontBold,
        color: value === 'Fail' ? rgb(0.7, 0.1, 0.1) : rgb(0, 0, 0),
      })
    } else if (f.type === 'checkgroup') {
      const size = Math.max(8, Math.min(12, fh * 0.6))
      let cx = x
      for (const opt of ['OK', 'Fail', 'N/A']) {
        const mark = f.value === opt ? '[X]' : '[  ]'
        const t = `${mark} ${opt}   `
        page.drawText(t, { x: cx, y: yBottom + (fh - size) / 2, size, font })
        cx += font.widthOfTextAtSize(t, size)
      }
    } else if (f.type === 'signature') {
      if (!f.value || !f.value.name) continue
      page.drawRectangle({
        x,
        y: yBottom,
        width: fw,
        height: fh,
        borderColor: rgb(0.16, 0.22, 0.45),
        borderWidth: 1,
        color: rgb(0.96, 0.97, 1),
      })
      const nameSize = Math.max(9, Math.min(13, fh * 0.32))
      page.drawText(f.value.name, {
        x: x + 5,
        y: yBottom + fh - nameSize - 5,
        size: nameSize,
        font: fontBold,
        color: rgb(0.12, 0.16, 0.35),
      })
      page.drawText(`Signed: ${f.value.timestamp}`, {
        x: x + 5,
        y: yBottom + 5,
        size: 8,
        font,
        color: rgb(0.3, 0.3, 0.3),
      })
    }
  }

  return await pdfDoc.save()
}

// Create a single blank A4 page so users can try the tool without uploading a file.
export async function makeBlankPdf() {
  const pdfDoc = await PDFDocument.create()
  pdfDoc.addPage([595.28, 841.89]) // A4 in points
  return await pdfDoc.save()
}
