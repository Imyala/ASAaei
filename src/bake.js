import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'

// Draw all field values directly onto the PDF and return flattened bytes.
// "Flattened" = the values become part of the page content, so the result is a
// plain, non-editable PDF — this is what enforces "locked after signing".
//
// Fields are stored in VIEWPORT space (the rendered, rotation-applied image the
// tech placed them on). pdf-lib draws in the page's UNROTATED user space, so for
// a /Rotate 90/180/270 page we map each displayed point back to user space and
// draw the glyphs rotated to match — otherwise baked values land in the wrong
// place on landscape (rotated) inspection sheets. Portrait pages (rotate 0) go
// through the identity mapping and bake exactly as before.
// `pageOrder`, when given, is the list of ORIGINAL page indices to keep, in the
// order to keep them (from the page picker — selection + drag reorder). The
// output then contains only those pages, reordered, with each field baked onto
// every place its source page now appears. Omit it to bake the whole document.
export async function bakePdf(originalBytes, fields, pageOrder) {
  const src = await PDFDocument.load(originalBytes)
  let pdfDoc
  if (pageOrder && pageOrder.length) {
    pdfDoc = await PDFDocument.create()
    const copied = await pdfDoc.copyPages(src, pageOrder)
    copied.forEach((p) => pdfDoc.addPage(p))
  } else {
    pdfDoc = src
  }
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const pages = pdfDoc.getPages()
  // original page index -> the new indices it maps to (usually one, but a page
  // could in principle be included more than once).
  const targetsFor = (origPage) =>
    pageOrder && pageOrder.length
      ? pageOrder.reduce((acc, orig, i) => (orig === origPage ? (acc.push(i), acc) : acc), [])
      : (pages[origPage] ? [origPage] : [])

  for (const f of fields) {
    for (const ti of targetsFor(f.page)) {
    const page = pages[ti]
    if (!page) continue
    const { width: uw, height: uh } = page.getSize() // unrotated user-space size
    const r = ((page.getRotation().angle % 360) + 360) % 360
    const rotated = r === 90 || r === 270
    const vw = rotated ? uh : uw // viewport (displayed) size
    const vh = rotated ? uw : uh
    // Field box in displayed (viewport, top-origin) coordinates.
    const vx = f.xPct * vw, vy = f.yPct * vh
    const fw = f.wPct * vw, fh = f.hPct * vh
    const rotate = degrees(r)
    // Map a displayed point (top-origin) to unrotated user space (bottom-origin).
    const toUser = (px, py) => {
      switch (r) {
        case 90: return [py, px]
        case 180: return [uw - px, py]
        case 270: return [uw - py, uh - px]
        default: return [px, uh - py]
      }
    }
    // Draw text whose displayed baseline starts at viewport point (dx, dy).
    const drawText = (value, dx, dy, size, useFont, color) => {
      const [ux, uy] = toUser(dx, dy)
      page.drawText(value, { x: ux, y: uy, size, font: useFont, color, rotate })
    }

    if (f.type === 'text' || f.type === 'dropdown') {
      const value = String(f.value ?? '')
      if (!value) continue
      const size = Math.max(8, Math.min(13, fh * 0.6))
      drawText(value, vx + 2, vy + (fh + size) / 2, size, font, rgb(0, 0, 0))
    } else if (f.type === 'status') {
      // Tri-state OK / Fail / N/A cell — draw the chosen value centred.
      const value = String(f.value ?? '')
      if (!value) continue
      const size = Math.max(8, Math.min(12, fh * 0.62))
      const tw = fontBold.widthOfTextAtSize(value, size)
      drawText(value, vx + Math.max(1, (fw - tw) / 2), vy + (fh + size) / 2, size,
        fontBold, value === 'Fail' ? rgb(0.7, 0.1, 0.1) : rgb(0, 0, 0))
    } else if (f.type === 'checkgroup') {
      const size = Math.max(8, Math.min(12, fh * 0.6))
      let cx = vx
      for (const opt of ['OK', 'N/A', 'Fail']) {
        const mark = f.value === opt ? '[X]' : '[  ]'
        const t = `${mark} ${opt}   `
        drawText(t, cx, vy + (fh + size) / 2, size, font, rgb(0, 0, 0))
        cx += font.widthOfTextAtSize(t, size)
      }
    } else if (f.type === 'signature') {
      if (!f.value || !f.value.name) continue
      const [rx, ry] = toUser(vx, vy + fh) // displayed bottom-left corner
      page.drawRectangle({
        x: rx, y: ry, width: fw, height: fh, rotate,
        borderColor: rgb(0.16, 0.22, 0.45), borderWidth: 1, color: rgb(0.96, 0.97, 1),
      })
      const nameSize = Math.max(9, Math.min(13, fh * 0.32))
      drawText(f.value.name, vx + 5, vy + nameSize + 5, nameSize, fontBold, rgb(0.12, 0.16, 0.35))
      drawText(`Signed: ${f.value.timestamp}`, vx + 5, vy + fh - 5, 8, font, rgb(0.3, 0.3, 0.3))
    }
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
