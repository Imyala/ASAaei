// Tests for the .docx stall-trigger scan: the zip reader and the two traits
// it looks for. The zips are built here, byte by byte, so the tests hold
// whatever archiver a real document came from.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { listZipEntries, readZipEntry, docxEngineRisks } from './docxRisks.js'

// Build a real zip from { name, data, store } parts — deflated by default,
// stored when asked — matching what Word itself produces closely enough for
// the reader under test.
function makeZip(parts) {
  const enc = new TextEncoder()
  const chunks = []
  const central = []
  let offset = 0
  for (const part of parts) {
    const name = enc.encode(part.name)
    const data = typeof part.data === 'string' ? enc.encode(part.data) : part.data
    const comp = part.store ? data : new Uint8Array(deflateRawSync(data))
    const method = part.store ? 0 : 8

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, comp.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    chunks.push(local, comp)

    const cen = new Uint8Array(46 + name.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, comp.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cen.set(name, 46)
    central.push(cen)

    offset += local.length + comp.length
  }
  const cenStart = offset
  let cenSize = 0
  for (const c of central) { chunks.push(c); cenSize += c.length }
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, cenSize, true)
  ev.setUint32(16, cenStart, true)
  chunks.push(eocd)

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

const PLAIN_DOCX_PARTS = [
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: '<w:document>hello</w:document>' },
  { name: 'word/media/image1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), store: true },
]

test('the zip reader lists entries and round-trips their contents', async () => {
  const zip = makeZip(PLAIN_DOCX_PARTS)
  const entries = listZipEntries(zip)
  assert.deepEqual(entries.map((e) => e.name), PLAIN_DOCX_PARTS.map((p) => p.name))
  const doc = await readZipEntry(zip, entries[1])
  assert.equal(new TextDecoder().decode(doc), '<w:document>hello</w:document>')
  const png = await readZipEntry(zip, entries[2]) // stored, not deflated
  assert.deepEqual(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
})

test('a document with none of the stall triggers scans clean', async () => {
  assert.deepEqual(await docxEngineRisks(makeZip(PLAIN_DOCX_PARTS)), [])
})

test('an EMF or WMF graphic is reported by name', async () => {
  const zip = makeZip([
    ...PLAIN_DOCX_PARTS,
    { name: 'word/media/image2.emf', data: new Uint8Array([1, 0, 0, 0]) },
  ])
  const risks = await docxEngineRisks(zip)
  assert.equal(risks.length, 1)
  assert.match(risks[0], /metafile/i)
  assert.match(risks[0], /image2\.emf/)
})

test('a picture in a header or footer is reported', async () => {
  const zip = makeZip([
    ...PLAIN_DOCX_PARTS,
    { name: 'word/header1.xml', data: '<w:hdr/>' },
    {
      name: 'word/_rels/header1.xml.rels',
      data: '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
    },
  ])
  const risks = await docxEngineRisks(zip)
  assert.deepEqual(risks, ['a picture in the page header or footer'])
})

test('a header without pictures is not a risk', async () => {
  const zip = makeZip([
    ...PLAIN_DOCX_PARTS,
    { name: 'word/header1.xml', data: '<w:hdr/>' },
    {
      name: 'word/_rels/header1.xml.rels',
      data: '<Relationships><Relationship Type=".../relationships/hyperlink" Target="https://example.com"/></Relationships>',
    },
  ])
  assert.deepEqual(await docxEngineRisks(zip), [])
})

test('bytes that are not a zip scan clean instead of failing the open', async () => {
  // A legacy .doc (OLE container) or a damaged download must not crash the
  // scan — the engine's own error handling answers for those.
  assert.deepEqual(await docxEngineRisks(new TextEncoder().encode('not a zip at all')), [])
  assert.deepEqual(await docxEngineRisks(new Uint8Array(0)), [])
})
