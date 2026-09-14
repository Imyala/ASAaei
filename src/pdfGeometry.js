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
  const stack = []
  const toTop = (pt) => toVP(pt[0], pt[1])

  const addSeg = (ax, ay, bx, by) => {
    if (Math.abs(ay - by) <= 1.2 && Math.abs(ax - bx) > 3) hlines.push({ y: (ay + by) / 2, x1: Math.min(ax, bx), x2: Math.max(ax, bx) })
    else if (Math.abs(ax - bx) <= 1.2 && Math.abs(ay - by) > 3) vlines.push({ x: (ax + bx) / 2, y1: Math.min(ay, by), y2: Math.max(ay, by) })
  }
  const addRect = (x, y, w, h) => {
    // corners in user space -> top-origin
    const p1 = toTop(Util.applyTransform([x, y], ctm))
    const p2 = toTop(Util.applyTransform([x + w, y + h], ctm))
    const rx = Math.min(p1[0], p2[0]), ry = Math.min(p1[1], p2[1])
    const rw = Math.abs(p2[0] - p1[0]), rh = Math.abs(p2[1] - p1[1])
    rects.push({ x: rx, y: ry, w: rw, h: rh })
    // its edges also feed the line grid
    addSeg(rx, ry, rx + rw, ry); addSeg(rx, ry + rh, rx + rw, ry + rh)
    addSeg(rx, ry, rx, ry + rh); addSeg(rx + rw, ry, rx + rw, ry + rh)
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
    else if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() || ctm
    else if (fn === OPS.transform) ctm = Util.transform(ctm, argsArray[i])
    else if (fn === OPS.constructPath) {
      const ops = argsArray[i][0]
      const co = argsArray[i][1]
      let k = 0
      let cur = null
      let start = null // subpath start, for closePath
      for (const op of ops) {
        if (op === OPS.moveTo) { cur = toTop(Util.applyTransform([co[k], co[k + 1]], ctm)); start = cur; k += 2 }
        else if (op === OPS.lineTo) { const nx = toTop(Util.applyTransform([co[k], co[k + 1]], ctm)); k += 2; if (cur) addSeg(cur[0], cur[1], nx[0], nx[1]); cur = nx }
        else if (op === OPS.rectangle) { addRect(co[k], co[k + 1], co[k + 2], co[k + 3]); k += 4 }
        else if (op === OPS.curveTo) { cur = toTop(Util.applyTransform([co[k + 4], co[k + 5]], ctm)); k += 6 }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { cur = toTop(Util.applyTransform([co[k + 2], co[k + 3]], ctm)); k += 4 }
        else if (op === OPS.closePath) { if (cur && start) { addSeg(cur[0], cur[1], start[0], start[1]); cur = start } }
      }
    }
  }
  return { hlines, vlines, rects, images }
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
