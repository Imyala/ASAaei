// ---------------------------------------------------------------------------
// Font awareness
// ---------------------------------------------------------------------------
// Fonts are the number-one cause of "the PDF doesn't match the Word document".
// LibreOffice lays out a document perfectly — but only if it has the fonts the
// document asks for. When a font is missing it substitutes a different one,
// the glyph widths change, and lines re-wrap, tables grow a row and page breaks
// move. Nothing about the converter is wrong; the machine is simply missing a
// typeface.
//
// So instead of failing silently, the server:
//   1. reads the font table out of the .docx (it is just a zip),
//   2. compares it against the fonts fontconfig actually has, and
//   3. reports the difference, per conversion and in /api/health,
// so the app can say "Verdana is missing — the layout may shift" and the
// operator can fix it once with `npm run setup-fonts`.

import { spawn } from 'node:child_process'
import zlib from 'node:zlib'

// Fonts that Word documents reach for constantly, and the free family that is
// METRIC-COMPATIBLE with each — same glyph widths, so lines break in exactly
// the same places. A metric-compatible substitute is as good as the real font
// for layout purposes; anything else is a guess that moves the text.
export const METRIC_SUBSTITUTES = {
  'Calibri': 'Carlito',
  'Cambria': 'Caladea',
  'Arial': 'Liberation Sans',
  'Helvetica': 'Liberation Sans',
  'Times New Roman': 'Liberation Serif',
  'Courier New': 'Liberation Mono',
  // Gelasio is metric-compatible with Georgia, but it is not in the Debian or
  // Ubuntu archives, so most machines fall through to the approximate entry.
  'Georgia': 'Gelasio',
}

// Fonts with NO metric-compatible free clone. The substitute chosen here is
// only the closest match by proportion — text set in these will render but may
// re-wrap, so these are the ones worth installing for real.
export const APPROXIMATE_SUBSTITUTES = {
  'Verdana': 'DejaVu Sans',
  'Tahoma': 'DejaVu Sans',
  'Segoe UI': 'Noto Sans',
  'Georgia': 'Noto Serif',
  'Trebuchet MS': 'Noto Sans',
  'MS Gothic': 'Noto Sans CJK JP',
  'MS Mincho': 'Noto Serif CJK JP',
  // Office 2024 made Aptos the default body font, so newly-authored forms
  // arrive set in it. It is too new to have a free clone of any kind.
  'Aptos': 'Noto Sans',
  'Aptos Display': 'Noto Sans',
  'Aptos Narrow': 'Noto Sans',
}

// The maps above are written with the family names spelled as a person would
// read them; every lookup goes through these lower-cased indexes.
const lowerIndex = (map) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]))
const METRIC_BY_KEY = lowerIndex(METRIC_SUBSTITUTES)
const APPROX_BY_KEY = lowerIndex(APPROXIMATE_SUBSTITUTES)

// Families that are always present as far as layout is concerned: either they
// are generic aliases or LibreOffice ships them.
const ALWAYS_OK = new Set(['symbol', 'wingdings', 'wingdings 2', 'wingdings 3',
  'webdings', 'opensymbol', 'segoe ui symbol', 'segoe ui emoji', 'cambria math'])

// Turn a PostScript font name back into the family a user would recognise.
//
// A .docx that has been round-tripped through a PDF tool carries names like
// "TimesNewRomanPSMT" or "Arial-BoldMT" instead of "Times New Roman" and
// "Arial". Left alone they never match an installed family, so the app reports
// Times New Roman as missing on a machine that plainly has it.
export function normaliseFamily(raw) {
  let n = String(raw || '').trim()
  // "-BoldMT", ",Italic", "-BoldItalic" — a weight, not part of the family.
  n = n.replace(/[-,]\s*(bold\s*italic|bold|italic|oblique|regular|light|black|semibold)(mt|ps)?$/i, '')
  n = n.replace(/(PS)?MT$/, '').replace(/PS$/, '')
  // "TimesNewRoman" -> "Times New Roman", but leave "Arial" and "Segoe UI" be.
  if (!/\s/.test(n) && /[a-z][A-Z]/.test(n)) n = n.replace(/([a-z])([A-Z])/g, '$1 $2')
  return n.trim()
}

let installedCache = null

// The families fontconfig can resolve on this machine, lower-cased.
export async function installedFamilies({ refresh = false } = {}) {
  if (installedCache && !refresh) return installedCache
  const out = await run('fc-list', [':', 'family']).catch(() => '')
  const set = new Set()
  for (const line of out.split('\n')) {
    // fc-list prints comma-separated aliases for one file; each is a family.
    for (const fam of line.split(',')) {
      const f = fam.trim().toLowerCase()
      if (f) set.add(f)
    }
  }
  installedCache = set
  return set
}

// Which of the fonts this document asks for are unavailable, and what will
// stand in for each. `substitute` names the family that will actually be used;
// `metric` says whether that stand-in preserves the original's glyph widths
// (and therefore the line breaks and page count).
export async function checkFonts(fontNames) {
  const installed = await installedFamilies()
  const missing = []
  const seen = new Set()
  for (const raw of fontNames) {
    // Documents reference weights as separate families ("Arial Bold"), but a
    // weight is not a family — the base family carries it. Check the base.
    const name = normaliseFamily(raw).replace(/\s+(bold|italic|oblique|light|black)\b/gi, '').trim()
    const key = name.toLowerCase()
    if (!name || ALWAYS_OK.has(key) || seen.has(key)) continue
    seen.add(key)
    if (installed.has(key)) continue
    const metricSub = METRIC_BY_KEY[key]
    const approxSub = APPROX_BY_KEY[key]
    const sub = metricSub || approxSub
    // A metric-compatible clone that is itself installed is a non-issue.
    if (metricSub && installed.has(metricSub.toLowerCase())) continue
    missing.push({
      font: name,
      substitute: sub || null,
      // True only when the stand-in is installed AND width-compatible.
      metric: Boolean(metricSub) && installed.has(String(metricSub).toLowerCase()),
    })
  }
  return missing
}

// A summary for /api/health, expressed in terms of the fonts DOCUMENTS ask for
// rather than which clone packages happen to be installed.
//
// The distinction matters for the UI. Listing "Gelasio" as missing — a package
// that isn't in the Debian or Ubuntu archives at all — is noise the operator
// can do nothing about, and noise in a health panel teaches people to ignore
// it. What is worth reporting is a document font with no coverage of any kind,
// because that is the one that will render as a default serif and re-flow.
export async function fontReport() {
  const installed = await installedFamilies({ refresh: true })
  const sources = [...new Set([
    ...Object.keys(METRIC_SUBSTITUTES),
    ...Object.keys(APPROXIMATE_SUBSTITUTES),
  ])]

  const exact = []   // the genuine font is here: pixel-identical
  const metric = []  // a width-compatible clone: same line breaks
  const approx = []  // a close-proportion stand-in: text may re-wrap
  const missing = [] // nothing at all
  for (const font of sources) {
    const key = font.toLowerCase()
    if (installed.has(key)) { exact.push(font); continue }
    const m = METRIC_BY_KEY[key]
    if (m && installed.has(m.toLowerCase())) { metric.push(font); continue }
    const a = APPROX_BY_KEY[key]
    if (a && installed.has(a.toLowerCase())) { approx.push(font); continue }
    missing.push(font)
  }
  return { families: installed.size, exact, metric, approx, missing }
}

// ---------------------------------------------------------------------------
// Reading the font table out of a .docx
// ---------------------------------------------------------------------------
// A .docx is a zip. We only want two small entries from it, so rather than take
// a dependency we walk the zip's central directory and inflate just those.

const FONT_PARTS = ['word/fontTable.xml', 'word/styles.xml', 'word/document.xml']

// Both patterns have to be anchored to their element. `w:name` on its own also
// matches the several hundred `<w:lsdException w:name="heading 1">` entries
// Word writes into styles.xml, which are style names, not typefaces.
const FONT_DECL = /<w:font\s+[^>]*w:name="([^"]+)"/g
const FONT_REF = /<w:rFonts\s+[^>]*?w:(?:ascii|hAnsi)="([^"]+)"/g

export function fontsUsedInDocx(buffer) {
  const names = new Set()
  try {
    for (const part of FONT_PARTS) {
      const xml = readZipEntry(buffer, part)
      if (!xml) continue
      const text = xml.toString('utf8')
      for (const rx of [FONT_DECL, FONT_REF]) {
        rx.lastIndex = 0
        for (const m of text.matchAll(rx)) {
          const n = m[1].trim()
          // Word writes theme placeholders like "+mn-lt"; they are not families.
          if (n && !n.startsWith('+')) names.add(n)
        }
      }
    }
  } catch {
    // A malformed or unusual package just means no font advice — never a
    // reason to fail the conversion.
  }
  return [...names]
}

// Locate one entry via the zip central directory and inflate it.
function readZipEntry(buf, wantName) {
  const eocd = findEndOfCentralDirectory(buf)
  if (!eocd) return null
  const { entries, cdOffset } = eocd

  let p = cdOffset
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null // not a central header
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')

    if (name === wantName) {
      // The local header repeats the name/extra lengths, and they can differ
      // from the central copy, so read the real data offset from there.
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) return null
      const lNameLen = buf.readUInt16LE(localOffset + 26)
      const lExtraLen = buf.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + lNameLen + lExtraLen
      const raw = buf.slice(start, start + compSize)
      if (method === 0) return raw            // stored
      if (method === 8) return zlib.inflateRawSync(raw) // deflate
      return null                              // some other method: skip
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

function findEndOfCentralDirectory(buf) {
  // The EOCD is at the end, after a comment of up to 64 KB.
  const min = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return { entries: buf.readUInt16LE(i + 10), cdOffset: buf.readUInt32LE(i + 16) }
    }
  }
  return null
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }) }
    catch (err) { reject(err); return }
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('error', reject)
    const timer = setTimeout(() => { try { child.kill() } catch {}; reject(new Error('timeout')) }, 15_000)
    child.on('exit', () => { clearTimeout(timer); resolve(out) })
  })
}
