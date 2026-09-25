// ---------------------------------------------------------------------------
// Page geometry — pure readers of a pdf.js operator list and text content
// ---------------------------------------------------------------------------
// Kept free of any pdf.js *import* (the pdf.js OPS/Util helpers are passed in)
// so the same code runs in the browser and in a Node harness against a real
// converted PDF. `pdfBoxes.js` wires it to the worker-backed pdf.js build.

// Walk the operator list, tracking the CTM, and collect axis-aligned lines and
// rectangles in viewport (rotated, top-origin) point coordinates. `toVP` maps a
// user-space point into that frame (page rotation included).
export function collectGeometry(opList, toVP, { OPS, Util }) {
  const { fnArray, argsArray } = opList
  const hlines = [] // { y, x1, x2 }
  const vlines = [] // { x, y1, y2 }
  const rects = []  // { x, y, w, h } top-origin
  // Where pictures are drawn. A framed logo is a rectangle with nothing but an
  // image inside it, which is indistinguishable from an empty box by geometry
  // alone — on the cover page of a real procedure that put a fillable field on
  // top of the company logo.
  const images = [] // { x, y, w, h } top-origin
  let ctm = [1, 0, 0, 1, 0, 0]
  // The fill colour in force, saved and restored with the transform, so a
  // filled rectangle knows its colour (see paragraphShading).
  let fillColor = ''
  const stack = []
  const toTop = (pt) => toVP(pt[0], pt[1])
  // Per rectangle: the colour it was filled with ('' when only stroked or
  // used as a clip), and the rule segments its edges added.
  const rectFill = []
  const rectSegs = []
  let pending = [] // rectangles of the path now being built, awaiting paint
  let shape = null // the extent of that path, when it has curves or slants
  const FILLS = new Set(FILL_OPS.map((n) => OPS[n]))
  const ENDS = new Set(END_OPS.map((n) => OPS[n]))

  const addSeg = (ax, ay, bx, by) => {
    let seg = null
    if (Math.abs(ay - by) <= 1.2 && Math.abs(ax - bx) > 3) hlines.push(seg = { y: (ay + by) / 2, x1: Math.min(ax, bx), x2: Math.max(ax, bx) })
    else if (Math.abs(ax - bx) <= 1.2 && Math.abs(ay - by) > 3) vlines.push(seg = { x: (ax + bx) / 2, y1: Math.min(ay, by), y2: Math.max(ay, by) })
    return seg
  }
  const addRect = (x, y, w, h) => {
    // corners in user space -> top-origin
    const p1 = toTop(Util.applyTransform([x, y], ctm))
    const p2 = toTop(Util.applyTransform([x + w, y + h], ctm))
    const rx = Math.min(p1[0], p2[0]), ry = Math.min(p1[1], p2[1])
    const rw = Math.abs(p2[0] - p1[0]), rh = Math.abs(p2[1] - p1[1])
    rects.push({ x: rx, y: ry, w: rw, h: rh })
    // its edges also feed the line grid
    rectSegs.push([
      addSeg(rx, ry, rx + rw, ry), addSeg(rx, ry + rh, rx + rw, ry + rh),
      addSeg(rx, ry, rx, ry + rh), addSeg(rx + rw, ry, rx + rw, ry + rh),
    ].filter(Boolean))
    rectFill.push('')
    pending.push(rects.length - 1)
  }

  // An image is painted through the CTM as the unit square, so the current
  // transform is its placed rectangle.
  const addImage = () => {
    const p1 = toTop(Util.applyTransform([0, 0], ctm))
    const p2 = toTop(Util.applyTransform([1, 1], ctm))
    const x = Math.min(p1[0], p2[0]), y = Math.min(p1[1], p2[1])
    const w = Math.abs(p2[0] - p1[0]), h = Math.abs(p2[1] - p1[1])
    if (w > 2 && h > 2) images.push({ x, y, w, h })
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject
        || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject) addImage()
    else if (fn === OPS.save) stack.push([ctm, fillColor])
    else if (fn === OPS.restore) { const top = stack.pop(); if (top) [ctm, fillColor] = top }
    else if (fn === OPS.transform) ctm = Util.transform(ctm, argsArray[i])
    else if (fn === OPS.setFillRGBColor) fillColor = JSON.stringify(argsArray[i])
    else if (FILLS.has(fn)) {
      for (const k of pending) rectFill[k] = fillColor || 'default'
      pending = []
      // A small filled shape of curves or slanted lines is a drawing — a
      // tick mark or an icon converted from a picture — and counts as one.
      if (shape && shape.x2 - shape.x1 >= 3 && shape.y2 - shape.y1 >= 3 && shape.x2 - shape.x1 <= 40 && shape.y2 - shape.y1 <= 40) {
        images.push({ x: shape.x1, y: shape.y1, w: shape.x2 - shape.x1, h: shape.y2 - shape.y1, drawn: true })
      }
      shape = null
    } else if (ENDS.has(fn)) { pending = []; shape = null }
    else if (fn === OPS.constructPath) {
      pending = []
      shape = null
      const ops = argsArray[i][0]
      const co = argsArray[i][1]
      let k = 0
      let cur = null
      let start = null // subpath start, for closePath
      let shaped = false
      const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
      const at = (pt) => { box.x1 = Math.min(box.x1, pt[0]); box.y1 = Math.min(box.y1, pt[1]); box.x2 = Math.max(box.x2, pt[0]); box.y2 = Math.max(box.y2, pt[1]); return pt }
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = at(toTop(Util.applyTransform([co[k], co[k + 1]], ctm))); start = cur; k += 2 }
        else if (op === OPS.lineTo) {
          const nx = at(toTop(Util.applyTransform([co[k], co[k + 1]], ctm))); k += 2
          if (cur) {
            addSeg(cur[0], cur[1], nx[0], nx[1])
            if (Math.abs(nx[0] - cur[0]) > 1.2 && Math.abs(nx[1] - cur[1]) > 1.2) shaped = true
          }
          cur = nx
        }
        else if (op === OPS.rectangle) { addRect(co[k], co[k + 1], co[k + 2], co[k + 3]); k += 4 }
        else if (op === OPS.curveTo) { cur = at(toTop(Util.applyTransform([co[k + 4], co[k + 5]], ctm))); k += 6; shaped = true }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { cur = at(toTop(Util.applyTransform([co[k + 2], co[k + 3]], ctm))); k += 4; shaped = true }
        else if (op === OPS.closePath) { if (cur && start) { addSeg(cur[0], cur[1], start[0], start[1]); cur = start } }
      }
      if (shaped) shape = box
    }
  }
  // Paragraph shading is not a table. Word shades a paragraph as a rectangle
  // hugging its lines, inset from the cell's sides by the cell margins, over
  // the cell's own shading of the same colour: the grey behind "Unit No" in a
  // grey column heading. Its edges sit under 3 points inside the cell's
  // borders, close enough to fuse with them, so its bottom edge closed a
  // blank "cell" under the heading and a box was put there. Such rectangles
  // are dropped along with the rules their edges added.
  const drop = paragraphShading(rects, rectFill)
  if (drop.size) {
    const segs = new Set([...drop].flatMap((k) => rectSegs[k]))
    return {
      hlines: hlines.filter((l) => !segs.has(l)),
      vlines: vlines.filter((l) => !segs.has(l)),
      rects: rects.filter((_, k) => !drop.has(k)),
      images,
    }
  }
  return { hlines, vlines, rects, images }
}

// The operators that paint the current path filled, and those that end it
// without filling (a stroke, a clip).
const FILL_OPS = ['fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke']
const END_OPS = ['stroke', 'closeStroke', 'endPath']

// The indices of rectangles that are paragraph shading: filled, lying inside
// a taller filled rectangle of the same colour, and inset from both of its
// sides by the same small margin. A table nested in a cell draws its own
// borders, which are separate rules and stay; a white box on a grey panel is
// a different colour and stays.
export function paragraphShading(rects, fills) {
  const out = new Set()
  rects.forEach((r, k) => {
    if (!fills[k] || r.w <= 3 || r.h <= 3) return
    const inCell = rects.some((p, j) => {
      if (j === k || fills[j] !== fills[k] || p.h < r.h + 4) return false
      const left = r.x - p.x, right = p.x + p.w - (r.x + r.w)
      return left >= 0.5 && left <= 8 && right >= 0.5 && right <= 8 && Math.abs(left - right) <= 1.5
        && r.y >= p.y - 0.5 && r.y + r.h <= p.y + p.h + 0.5
    })
    if (inCell) out.add(k)
  })
  return out
}

// Text items as tokens in the same viewport frame: left/right edge, baseline
// (top-origin) and font height.
export function textTokens(items, toVP) {
  return items
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      const tr = it.transform
      const adv = it.width || 0
      const un = Math.hypot(tr[0], tr[1]) || 1
      const [x0, y0] = toVP(tr[4], tr[5])                                       // baseline start
      const [x1, y1] = toVP(tr[4] + adv * tr[0] / un, tr[5] + adv * tr[1] / un) // baseline end
      const fs = Math.hypot(tr[2], tr[3]) || Math.hypot(tr[0], tr[1]) || it.height || 9
      return { str: it.str.trim(), x: Math.min(x0, x1), xr: Math.max(x0, x1), yTop: Math.min(y0, y1), h: fs }
    })
}
