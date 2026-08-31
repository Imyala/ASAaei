// ---------------------------------------------------------------------------
// Known stall triggers for the in-page LibreOffice engine
// ---------------------------------------------------------------------------
// The WebAssembly engine build stalls indefinitely — verified against real
// documents — on two things a .docx can carry:
//
//   • an EMF or WMF graphic (Windows metafiles; Word's own clip-art and
//     pasted-from-Excel pictures are often stored this way), and
//   • a picture referenced from a page header or footer.
//
// Both stall the engine's PDF export at the same step forever (upstream bug;
// the converter service handles the identical documents in seconds). Letting
// the user watch "Loading document (30%)" for ten minutes is not honest, so
// the file is inspected for these two traits BEFORE the engine is handed the
// document, and the app refuses fast, with the working routes, instead.
//
// A .docx is a plain zip, so the inspection needs only the zip's central
// directory (for the file listing) and, for header/footer relationship parts,
// the browser's own DecompressionStream — the same API the engine download
// already depends on. No new dependency.

// ---- minimal zip reader ----------------------------------------------------

const EOCD_SIG = 0x06054b50 // end of central directory
const CEN_SIG = 0x02014b50 // central directory entry
const LOC_SIG = 0x04034b50 // local file header

// List the entries of a zip from its central directory. Returns
// [{ name, method, compSize, localOffset }] — enough to grep names and to
// read individual parts. Throws on anything that is not a readable zip; the
// caller treats that as "nothing detected" rather than as a failure, because
// this scan is advisory.
export function listZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The EOCD sits at the very end, before an optional comment of up to 64 KB:
  // scan backwards for its signature.
  const tail = Math.max(0, bytes.length - 65557)
  let eocd = -1
  for (let i = bytes.length - 22; i >= tail; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record')
  const count = view.getUint16(eocd + 10, true)
  let off = view.getUint32(eocd + 16, true)

  const entries = []
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (off + 46 > bytes.length || view.getUint32(off, true) !== CEN_SIG) {
      throw new Error('not a zip: central directory is damaged')
    }
    const method = view.getUint16(off + 10, true)
    const compSize = view.getUint32(off + 20, true)
    const nameLen = view.getUint16(off + 28, true)
    const extraLen = view.getUint16(off + 30, true)
    const commentLen = view.getUint16(off + 32, true)
    const localOffset = view.getUint32(off + 42, true)
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen))
    entries.push({ name, method, compSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// Read one entry's bytes. Only the two methods a .docx actually uses are
// supported: stored (0) and deflate (8).
export async function readZipEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const off = entry.localOffset
  if (off + 30 > bytes.length || view.getUint32(off, true) !== LOC_SIG) {
    throw new Error(`zip entry ${entry.name}: bad local header`)
  }
  // The local header repeats the name/extra fields, possibly with different
  // extra-field lengths than the central directory — read its own lengths.
  const nameLen = view.getUint16(off + 26, true)
  const extraLen = view.getUint16(off + 28, true)
  const start = off + 30 + nameLen + extraLen
  const comp = bytes.subarray(start, start + entry.compSize)
  if (entry.method === 0) return comp.slice()
  if (entry.method !== 8) throw new Error(`zip entry ${entry.name}: unsupported compression method ${entry.method}`)
  const stream = new Blob([comp]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// ---- the scan --------------------------------------------------------------

// The relationship type Word uses to point a part at an image. Matched
// case-insensitively on the tail so schema-prefix variations don't matter.
const IMAGE_REL = /relationships\/image["'\s]/i

// Inspect .docx bytes for the traits that stall the in-page engine. Returns a
// list of plain-language findings, empty when none apply (or when the bytes
// are not a zip at all — a legacy .doc, a damaged file: the engine's own
// error handling covers those).
export async function docxEngineRisks(bytes) {
  let entries
  try { entries = listZipEntries(bytes) } catch { return [] }

  const risks = []

  const metafiles = entries.filter((e) => /^word\/media\/[^/]+\.(emf|wmf)$/i.test(e.name))
  if (metafiles.length) {
    risks.push(`a Windows metafile graphic (${metafiles.map((e) => e.name.replace(/^word\/media\//, '')).join(', ')})`)
  }

  // A header/footer with a picture in it: each header/footer part that uses
  // an image carries a .rels file naming an image relationship. The .rels
  // parts are tiny, so unpacking them costs nothing.
  const rels = entries.filter((e) => /^word\/_rels\/(header|footer)\d*\.xml\.rels$/i.test(e.name))
  const dec = new TextDecoder()
  for (const rel of rels) {
    try {
      const xml = dec.decode(await readZipEntry(bytes, rel))
      if (IMAGE_REL.test(xml)) {
        risks.push('a picture in the page header or footer')
        break
      }
    } catch { /* unreadable part — stay quiet rather than block a good file */ }
  }

  return risks
}
