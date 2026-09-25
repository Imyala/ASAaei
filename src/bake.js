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
  // The standard fonts only carry the Windows-1252 characters, and one that
  // is not among them ("✓", "≤", an emoji) made the whole download fail.
  const safe = (value) => encodable(font, value)
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
      const value = safe(String(f.value ?? ''))
      if (!value) continue
      // The value stays inside its box: a long entry wraps onto more lines
      // where the box is tall enough (an Action Taken cell), and shrinks where
      // it is not (a reading in the performance test run table), instead of
      // running over the neighbouring cells.
      const { size, lines } = fitText(value, font, Math.max(6, Math.min(13, fh * 0.6)), fw - 4, fh - 2)
      const lead = size * 1.15
      const firstBaseline = lines.length === 1
        ? vy + (fh + size * 0.72) / 2
        : vy + 1 + size * 0.9
      lines.forEach((line, k) => drawText(line, vx + 2, firstBaseline + k * lead, size, font, rgb(0, 0, 0)))
    } else if (f.type === 'status') {
      // Tri-state OK / Fail / N/A cell — draw the chosen value centred, at one
      // size for every cell unless the cell is too small for it.
      const value = safe(String(f.value ?? ''))
      if (!value) continue
      let size = Math.min(10, fh * 0.75)
      const w10 = fontBold.widthOfTextAtSize(value, size)
      if (w10 > fw - 2) size = Math.max(4, size * (fw - 2) / w10)
      const tw = fontBold.widthOfTextAtSize(value, size)
      // A cell that held a printed tick box ("☐") has its answer written over
      // the empty box, so the box is cleared first.
      if (f.covers) {
        const [rx, ry] = toUser(vx, vy + fh)
        page.drawRectangle({ x: rx, y: ry, width: fw, height: fh, rotate, color: rgb(1, 1, 1) })
      }
      drawText(value, vx + Math.max(1, (fw - tw) / 2), vy + (fh + size * 0.72) / 2, size,
        fontBold, value === 'Fail' ? rgb(0.7, 0.1, 0.1) : rgb(0, 0, 0))
    } else if (f.type === 'checkgroup') {
      const size = 10
      let cx = vx
      for (const opt of ['OK', 'N/A', 'Fail']) {
        const mark = f.value === opt ? '[X]' : '[  ]'
        const t = `${mark} ${opt}   `
        drawText(t, cx, vy + (fh + size) / 2, size, font, rgb(0, 0, 0))
        cx += font.widthOfTextAtSize(t, size)
      }
    } else if (f.type === 'signature') {
      if (!f.value || !f.value.name) continue
      const name = safe(f.value.name)
      const [rx, ry] = toUser(vx, vy + fh) // displayed bottom-left corner
      page.drawRectangle({
        x: rx, y: ry, width: fw, height: fh, rotate,
        borderColor: rgb(0.16, 0.22, 0.45), borderWidth: 1, color: rgb(0.96, 0.97, 1),
      })
      const nameSize = Math.max(9, Math.min(13, fh * 0.32))
      drawText(name, vx + 5, vy + nameSize + 5, nameSize, fontBold, rgb(0.12, 0.16, 0.35))
      drawText(safe(`Signed: ${f.value.timestamp}`), vx + 5, vy + fh - 5, 8, font, rgb(0.3, 0.3, 0.3))
    }
    }
  }

  return await pdfDoc.save()
}

// The characters of `value` the font can draw; the common ones it cannot
// are spelled out, anything else becomes "?".
const SPELLED = { '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '≤': '<=', '≥': '>=', 'Ω': 'Ohm', '−': '-', '☐': '[ ]' }
export function encodable(font, value) {
  try { font.encodeText(value); return value } catch { /* one or more characters it lacks */ }
  let out = ''
  for (const ch of value) {
    const alt = SPELLED[ch] ?? ch
    try { font.encodeText(alt); out += alt } catch { out += '?' }
  }
  return out
}

// The largest size (from `size` down) at which `value` fits a box `maxW` wide
// and `maxH` tall, wrapping at spaces onto as many lines as the height allows.
export function fitText(value, font, size, maxW, maxH) {
  const width = (t, s) => font.widthOfTextAtSize(t, s)
  const wrap = (s) => {
    const lines = []
    for (const para of value.split(/\n/)) {
      let line = ''
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word
        if (!line || width(next, s) <= maxW) line = next
        else { lines.push(line); line = word }
      }
      lines.push(line)
    }
    return lines
  }
  for (let s = size; s >= 5; s -= 0.5) {
    const lines = wrap(s)
    if (lines.length * s * 1.15 <= Math.max(maxH, s * 1.15) && lines.every((l) => width(l, s) <= maxW)) return { size: s, lines }
  }
  // Still too long at the smallest size: one line, scaled to the width.
  const one = value.replace(/\s+/g, ' ')
  const w = width(one, 5) || 1
  return { size: Math.max(3, Math.min(5, 5 * maxW / w)), lines: [one] }
}

// Create a single blank A4 page so users can try the tool without uploading a file.
export async function makeBlankPdf() {
  const pdfDoc = await PDFDocument.create()
  pdfDoc.addPage([595.28, 841.89]) // A4 in points
  return await pdfDoc.save()
}
