// ---------------------------------------------------------------------------
// Pre-flight for the LibreOffice engine inside the website
// ---------------------------------------------------------------------------
// The WebAssembly build of LibreOffice deadlocks on the pictures a Word
// document carries. Reproduced in headless Chromium against the pinned engine
// build with one-picture documents built by hand, one variable at a time:
//
//     PNG in the body or a header ........ hangs at "Loading document (30%)"
//     JPEG in the body or a header ....... hangs at "Saving (70%)"
//     EMF in the body or a header ........ hangs at "Saving (70%)"
//     BMP in a header, 64 px or 800 px ... converts in 8 s
//
// What separates them is not where the picture sits or how big it is, but
// how LibreOffice reads it: PNG, JPEG, GIF, TIFF and WebP are loaded lazily
// (the bytes are kept and decoded when the layout first needs the pixels),
// as are the vector formats (EMF/WMF/SVG, rendered on demand), while a BMP is
// decoded eagerly at import. In this engine build the on-demand path never
// returns — lok_documentLoad or lok_documentSaveAs is entered and the worker
// sits there for ever. An upstream engine fault this app cannot patch, but
// one it can route around: hand the engine a document with no lazily-read
// pictures in it.
//
// So before a .docx goes to the in-page engine, every picture in it is
// re-encoded as a 32-bit BMP with an alpha channel (BITMAPV4HEADER). The
// browser decodes the original — that is what a browser is good at — and the
// bytes are swapped inside the .docx package. Nothing about the layout moves:
// the picture's size on the page is fixed by the drawing's own extent in the
// document XML, not by the pixels, and the alpha channel keeps transparent
// logos transparent (verified: the engine honours it). It is a lossless
// re-encoding of the same pixels, capped only at MAX_SIDE pixels on the long
// side so a 12-megapixel photo does not become a 48 MB bitmap inside the
// engine's memory.
//
// Vector graphics (EMF, WMF, SVG that the browser cannot rasterise) are the
// one thing that cannot be re-encoded here — there is no EMF renderer in a
// browser — so they are replaced with a transparent 1×1 BMP: the layout keeps
// the space, the drawing itself is blank, and the caller is told so it can
// say so. The converter service renders these normally.
//
// Package names are left alone (word/media/image1.png keeps its name with BMP
// bytes inside): LibreOffice identifies a picture by its bytes, not by its
// name or its declared content type, and the rewritten package never leaves
// this conversion — it exists only to be fed to the engine.

import JSZip from 'jszip'

// Bitmap formats. PNG/JPEG/GIF/TIFF/WebP are the ones the engine reads
// lazily and hangs on; BMP is included so that every bitmap leaves here in
// the one encoding proven to work (a plain 32-bit BMP without a V4 header
// stalled in testing too). TIFF is decoded by no browser but Safari and falls
// through to the placeholder, with a note.
const RASTER = /\.(png|jpe?g|jfif|gif|tiff?|webp|bmp|dib)$/i
// Vector formats: rendered on demand by the engine, and that render is what
// hangs. SVG is tried in the browser first; the metafiles cannot be.
const VECTOR = /\.(emf|wmf|emz|wmz|svg|svgz)$/i

// A re-encoded picture is capped at this many pixels on its long side: 3000
// px is 300 dpi across a full A4 width, which is what the converter service
// itself produces at its "balanced" quality.
export const MAX_SIDE = 3000

// Every picture under word/ is rewritten. docProps/ holds only the package
// thumbnail, which the document import never opens.
export function needsRewrite(path) {
  if (!/^word\//i.test(path)) return false
  return RASTER.test(path) || VECTOR.test(path)
}

export const isVector = (path) => VECTOR.test(path)

// ---- BMP encoding ----------------------------------------------------------

// Encode non-premultiplied RGBA pixels (as canvas getImageData returns them)
// as a 32-bit BMP with a BITMAPV4HEADER and an explicit alpha mask. The V4
// header matters: a plain 32-bit BITMAPINFOHEADER bitmap has no defined alpha
// channel, and the engine stalled on one in testing; with the V4 masks the
// engine both loads it eagerly and keeps the transparency.
export function encodeBmp32(rgba, width, height) {
  if (!(width > 0 && height > 0) || rgba.length < width * height * 4) {
    throw new Error('encodeBmp32: pixel buffer does not match its dimensions')
  }
  const FILE_HEADER = 14
  const V4_HEADER = 108
  const stride = width * 4
  const pixelBytes = stride * height
  const out = new Uint8Array(FILE_HEADER + V4_HEADER + pixelBytes)
  const dv = new DataView(out.buffer)
  // BITMAPFILEHEADER
  out[0] = 0x42; out[1] = 0x4d // 'BM'
  dv.setUint32(2, out.length, true)
  dv.setUint32(10, FILE_HEADER + V4_HEADER, true)
  // BITMAPV4HEADER
  let o = FILE_HEADER
  dv.setUint32(o, V4_HEADER, true); o += 4
  dv.setInt32(o, width, true); o += 4
  dv.setInt32(o, height, true); o += 4 // positive: rows stored bottom-up
  dv.setUint16(o, 1, true); o += 2 // planes
  dv.setUint16(o, 32, true); o += 2 // bits per pixel
  dv.setUint32(o, 3, true); o += 4 // BI_BITFIELDS
  dv.setUint32(o, pixelBytes, true); o += 4
  dv.setInt32(o, 3780, true); o += 4 // 96 dpi, in pixels per metre
  dv.setInt32(o, 3780, true); o += 4
  dv.setUint32(o, 0, true); o += 4 // colours used
  dv.setUint32(o, 0, true); o += 4 // colours important
  dv.setUint32(o, 0x00ff0000, true); o += 4 // red mask
  dv.setUint32(o, 0x0000ff00, true); o += 4 // green mask
  dv.setUint32(o, 0x000000ff, true); o += 4 // blue mask
  dv.setUint32(o, 0xff000000, true); o += 4 // alpha mask
  dv.setUint32(o, 0x73524742, true); o += 4 // LCS_sRGB
  // 36 bytes of colour-space endpoints + 12 bytes of gamma: zero for sRGB.
  o += 48
  // Pixels: BGRA, bottom row first.
  let p = FILE_HEADER + V4_HEADER
  for (let y = height - 1; y >= 0; y--) {
    let s = y * stride
    for (let x = 0; x < width; x++, s += 4, p += 4) {
      out[p] = rgba[s + 2]
      out[p + 1] = rgba[s + 1]
      out[p + 2] = rgba[s]
      out[p + 3] = rgba[s + 3]
    }
  }
  return out
}

// The stand-in for a picture that cannot be re-encoded: one fully
// transparent pixel. The drawing's extent still reserves the space.
export const transparentBmp = () => encodeBmp32(new Uint8Array([0, 0, 0, 0]), 1, 1)

// ---- decoding in the browser ----------------------------------------------

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', dib: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
}

const extOf = (path) => (path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()

// Fit (w, h) inside MAX_SIDE, keeping the aspect ratio.
export function fitSide(w, h, max = MAX_SIDE) {
  const longest = Math.max(w, h)
  if (longest <= max) return [w, h]
  const k = max / longest
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c
}

// Decode a picture with the browser and return { rgba, width, height }, or
// throw when the browser cannot read it. createImageBitmap covers the raster
// formats; an <img> covers SVG (which needs intrinsic dimensions to
// rasterise — an SVG without them cannot be sized and falls to the caller).
export async function decodeInBrowser(bytes, path) {
  const blob = new Blob([bytes], { type: MIME[extOf(path)] || 'application/octet-stream' })
  let source
  let width
  let height
  try {
    source = await createImageBitmap(blob)
    width = source.width; height = source.height
  } catch {
    // SVG (and anything createImageBitmap refuses) via an image element.
    if (typeof Image === 'undefined') throw new Error('no decoder')
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.decoding = 'sync'
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('undecodable'))
        img.src = url
      })
      width = img.naturalWidth; height = img.naturalHeight
      source = img
    } finally {
      // Revoked after drawing below — the <img> keeps its decoded pixels.
      setTimeout(() => URL.revokeObjectURL(url), 0)
    }
  }
  if (!(width > 0 && height > 0)) throw new Error('picture has no dimensions')
  const [w, h] = fitSide(width, height)
  const canvas = makeCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  source.close?.()
  const { data } = ctx.getImageData(0, 0, w, h)
  return { rgba: data, width: w, height: h }
}

// ---- the rewrite -----------------------------------------------------------

// Rewrite a .docx so the in-page engine can read every picture in it.
//
// Returns { bytes, rewritten, blank, notes }: the bytes to convert (the
// original, untouched, when there was nothing to do), how many pictures were
// re-encoded, how many were replaced by a blank placeholder, and human
// sentences describing anything the reader of the PDF should know.
//
// `decode` is injectable so the rewrite can be tested outside a browser.
export async function prepareDocxForEngine(bytes, { onProgress, signal, decode = decodeInBrowser } = {}) {
  let zip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    // Not a zip — a legacy .doc, or something mislabelled. Not ours to fix;
    // the engine will say what it is.
    return { bytes, rewritten: 0, blank: 0, notes: [] }
  }
  const targets = Object.keys(zip.files).filter((p) => !zip.files[p].dir && needsRewrite(p))
  if (targets.length === 0) return { bytes, rewritten: 0, blank: 0, notes: [] }

  let rewritten = 0
  const blankVector = []
  const blankBitmap = []
  for (let i = 0; i < targets.length; i++) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    const path = targets[i]
    onProgress?.(`Preparing the pictures for the engine (${i + 1} of ${targets.length})…`)
    const data = await zip.file(path).async('uint8array')
    let replacement = null
    // Metafiles have no renderer in a browser; SVG might.
    if (!/\.(emf|wmf|emz|wmz)$/i.test(path)) {
      try {
        const { rgba, width, height } = await decode(data, path)
        replacement = encodeBmp32(rgba, width, height)
        rewritten++
      } catch {
        replacement = null
      }
    }
    if (!replacement) {
      replacement = transparentBmp()
      ;(isVector(path) ? blankVector : blankBitmap).push(path.split('/').pop())
    }
    zip.file(path, replacement)
  }
  const notes = []
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  if (blankVector.length) {
    notes.push(`${plural(blankVector.length, 'vector graphic (EMF/WMF/SVG) is', 'vector graphics (EMF/WMF/SVG) are')} `
      + 'left blank: the engine inside this page cannot draw that format, so the space is kept and the '
      + 'drawing is empty. The converter service renders them.')
  }
  if (blankBitmap.length) {
    notes.push(`${plural(blankBitmap.length, 'picture', 'pictures')} this browser could not decode `
      + `(${blankBitmap.join(', ')}) ${blankBitmap.length === 1 ? 'is' : 'are'} left blank.`)
  }
  onProgress?.('Packing the prepared document…')
  const out = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 }, // the engine unpacks it moments later
  })
  return { bytes: out, rewritten, blank: blankVector.length + blankBitmap.length, notes }
}
