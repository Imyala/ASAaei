// The pre-flight that makes a .docx safe for the in-page engine, tested
// without a browser: the BMP encoder is pure, and the package rewrite takes an
// injectable decoder. The engine-facing proof (a rewritten document converts
// where the original hung) is run in headless Chromium — see README.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {
  encodeBmp32, transparentBmp, needsRewrite, fitSide, prepareDocxForEngine, MAX_SIDE,
} from './docxPreflight.js'

const u32 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint32(o, true)
const i32 = (b, o) => new DataView(b.buffer, b.byteOffset).getInt32(o, true)
const u16 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint16(o, true)

test('encodeBmp32 writes a V4 bitmap with an alpha mask, rows bottom-up', () => {
  // 2×2: top-left red opaque, top-right transparent, bottom row green/blue.
  const rgba = new Uint8Array([
    255, 0, 0, 255, /**/ 0, 0, 0, 0,
    0, 255, 0, 255, /**/ 0, 0, 255, 128,
  ])
  const bmp = encodeBmp32(rgba, 2, 2)
  assert.equal(bmp.length, 14 + 108 + 16)
  assert.equal(String.fromCharCode(bmp[0], bmp[1]), 'BM')
  assert.equal(u32(bmp, 2), bmp.length)
  assert.equal(u32(bmp, 10), 122) // pixel offset
  assert.equal(u32(bmp, 14), 108) // BITMAPV4HEADER
  assert.equal(i32(bmp, 18), 2)
  assert.equal(i32(bmp, 22), 2)
  assert.equal(u16(bmp, 28), 32) // bpp
  assert.equal(u32(bmp, 30), 3) // BI_BITFIELDS
  assert.equal(u32(bmp, 54), 0x00ff0000) // R
  assert.equal(u32(bmp, 58), 0x0000ff00) // G
  assert.equal(u32(bmp, 62), 0x000000ff) // B
  assert.equal(u32(bmp, 66), 0xff000000) // A
  // First stored row is the BOTTOM row: green opaque, then blue half-alpha, as BGRA.
  assert.deepEqual([...bmp.subarray(122, 130)], [0, 255, 0, 255, 255, 0, 0, 128])
  // Then the top row: red opaque, transparent black.
  assert.deepEqual([...bmp.subarray(130, 138)], [0, 0, 255, 255, 0, 0, 0, 0])
})

test('encodeBmp32 refuses a buffer that does not match its size', () => {
  assert.throws(() => encodeBmp32(new Uint8Array(3), 1, 1))
  assert.throws(() => encodeBmp32(new Uint8Array(4), 0, 1))
})

test('the placeholder is a single fully transparent pixel', () => {
  const b = transparentBmp()
  assert.equal(i32(b, 18), 1)
  assert.equal(i32(b, 22), 1)
  assert.equal(b[122 + 3], 0)
})

test('only pictures under word/ are rewritten; xml and the thumbnail are not', () => {
  for (const p of ['word/media/image1.png', 'word/media/image2.JPG', 'word/media/logo.emf',
    'word/media/x.wmf', 'word/media/v.svg', 'word/media/a.gif', 'word/media/t.tiff',
    'word/media/w.webp', 'word/media/old.bmp']) {
    assert.equal(needsRewrite(p), true, p)
  }
  for (const p of ['word/document.xml', 'word/_rels/document.xml.rels', 'docProps/thumbnail.jpeg',
    '[Content_Types].xml', 'word/embeddings/oleObject1.bin', 'word/media/image1.png/']) {
    assert.equal(needsRewrite(p), false, p)
  }
})

test('fitSide caps the long side and keeps the aspect ratio', () => {
  assert.deepEqual(fitSide(640, 480), [640, 480])
  assert.deepEqual(fitSide(6000, 3000), [MAX_SIDE, MAX_SIDE / 2])
  assert.deepEqual(fitSide(1000, 9000), [Math.round(1000 * MAX_SIDE / 9000), MAX_SIDE])
})

async function docx(parts) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('word/document.xml', '<w:document/>')
  for (const [p, data] of Object.entries(parts)) zip.file(p, data)
  return zip.generateAsync({ type: 'uint8array' })
}

test('a document with no pictures is passed through untouched', async () => {
  const bytes = await docx({})
  const out = await prepareDocxForEngine(bytes, { decode: async () => { throw new Error('unused') } })
  assert.equal(out.bytes, bytes)
  assert.equal(out.rewritten, 0)
  assert.deepEqual(out.notes, [])
})

test('pictures become BMPs under their own names; metafiles become blanks with a note', async () => {
  const bytes = await docx({
    'word/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    'word/media/image2.jpeg': new Uint8Array([0xff, 0xd8]),
    'word/media/image3.emf': new Uint8Array([1, 0, 0, 0]),
    'word/header1.xml': '<w:hdr/>',
  })
  const decoded = []
  const decode = async (data, path) => {
    decoded.push(path)
    return { rgba: new Uint8Array([9, 8, 7, 255, 1, 2, 3, 4]), width: 2, height: 1 }
  }
  const out = await prepareDocxForEngine(bytes, { decode })
  assert.notEqual(out.bytes, bytes)
  assert.deepEqual(decoded.sort(), ['word/media/image1.png', 'word/media/image2.jpeg'])
  assert.equal(out.rewritten, 2)
  assert.equal(out.blank, 1)
  assert.equal(out.notes.length, 1)
  assert.match(out.notes[0], /1 vector graphic .* left blank/)

  const zip = await JSZip.loadAsync(out.bytes)
  assert.deepEqual(Object.keys(zip.files).sort(), [
    '[Content_Types].xml', 'word/', 'word/document.xml', 'word/header1.xml',
    'word/media/', 'word/media/image1.png', 'word/media/image2.jpeg', 'word/media/image3.emf',
  ])
  const png = await zip.file('word/media/image1.png').async('uint8array')
  assert.equal(String.fromCharCode(png[0], png[1]), 'BM')
  assert.equal(i32(png, 18), 2)
  const emf = await zip.file('word/media/image3.emf').async('uint8array')
  assert.deepEqual([...emf], [...transparentBmp()])
  assert.equal(await zip.file('word/header1.xml').async('string'), '<w:hdr/>')
})

test('a picture the browser cannot decode becomes a blank, and says which', async () => {
  const bytes = await docx({ 'word/media/scan.tif': new Uint8Array([0x49, 0x49, 0x2a, 0]) })
  const out = await prepareDocxForEngine(bytes, { decode: async () => { throw new Error('nope') } })
  assert.equal(out.rewritten, 0)
  assert.equal(out.blank, 1)
  assert.match(out.notes[0], /scan\.tif/)
})

test('bytes that are not a zip are returned as they came', async () => {
  const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3])
  const out = await prepareDocxForEngine(bytes, { decode: async () => { throw new Error('unused') } })
  assert.equal(out.bytes, bytes)
})

test('cancellation is honoured between pictures', async () => {
  const bytes = await docx({ 'word/media/a.png': new Uint8Array(4) })
  const ctl = new AbortController()
  ctl.abort()
  await assert.rejects(
    prepareDocxForEngine(bytes, { signal: ctl.signal, decode: async () => ({ rgba: new Uint8Array(4), width: 1, height: 1 }) }),
    (e) => e.name === 'AbortError')
})
