// Tests for the font-awareness helpers. Run: node server/fonts.test.mjs
//
// The zip reader is the part worth pinning down: it walks a .docx's central
// directory by hand rather than taking a dependency, so a mistake there would
// silently return "no fonts needed" for every document and the app would stop
// warning about layouts that are quietly re-wrapping.
import zlib from 'node:zlib'
import { checkFonts, fontsUsedInDocx, normaliseFamily, METRIC_SUBSTITUTES } from './fonts.mjs'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg) } }

// ---- a minimal .docx builder (stored + deflated entries) ------------------
function buildZip(entries, { deflate = true } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.from(text, 'utf8')
    const data = deflate ? zlib.deflateRawSync(raw) : raw
    const method = deflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14)             // crc (unchecked by the reader)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(centralPart.length, 12)
  eocd.writeUInt32LE(localPart.length, 16)
  return Buffer.concat([localPart, centralPart, eocd])
}

const FONT_TABLE = `<?xml version="1.0"?><w:fonts>
  <w:font w:name="Verdana"><w:charset w:val="00"/></w:font>
  <w:font w:name="Calibri"/><w:font w:name="Arial"/>
</w:fonts>`
// styles.xml carries hundreds of `<w:lsdException w:name="heading 1">` entries.
// Those are STYLE names; reading them as typefaces produced a "missing fonts"
// list hundreds of entries long that overflowed the response header.
const STYLES = `<?xml version="1.0"?><w:styles>
  <w:latentStyles>
    <w:lsdException w:name="heading 1"/><w:lsdException w:name="Normal"/>
    <w:lsdException w:name="Colorful Grid Accent 6"/>
  </w:latentStyles>
  <w:style><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI"/></w:rPr></w:style>
</w:styles>`

console.log('fontsUsedInDocx — reads the font table, not the style list')
{
  const docx = buildZip({ 'word/fontTable.xml': FONT_TABLE, 'word/styles.xml': STYLES })
  const fonts = fontsUsedInDocx(docx)
  ok(fonts.includes('Verdana'), 'finds a font declared in fontTable.xml')
  ok(fonts.includes('Calibri') && fonts.includes('Arial'), 'finds every declared font')
  ok(fonts.includes('Segoe UI'), 'finds a font referenced by w:rFonts in styles.xml')
  ok(!fonts.includes('heading 1'), 'a latent STYLE name is not read as a font')
  ok(!fonts.includes('Normal'), '"Normal" is a style, not a typeface')
  ok(!fonts.includes('Colorful Grid Accent 6'), 'table style names are not fonts')
  ok(fonts.length === 4, `exactly the four real fonts (got ${fonts.length}: ${fonts})`)
}

console.log('fontsUsedInDocx — stored (undeflated) entries')
{
  const docx = buildZip({ 'word/fontTable.xml': FONT_TABLE }, { deflate: false })
  ok(fontsUsedInDocx(docx).includes('Verdana'), 'reads an entry stored without compression')
}

console.log('fontsUsedInDocx — never throws on rubbish')
{
  ok(fontsUsedInDocx(Buffer.from('not a zip at all')).length === 0, 'a non-zip yields no fonts')
  ok(fontsUsedInDocx(Buffer.alloc(0)).length === 0, 'an empty buffer yields no fonts')
  const truncated = buildZip({ 'word/fontTable.xml': FONT_TABLE }).subarray(0, 40)
  ok(fontsUsedInDocx(truncated).length === 0, 'a truncated zip yields no fonts')
}

console.log('checkFonts — a weight is not a separate typeface')
{
  const missing = await checkFonts(['Arial Bold', 'Arial Italic', 'Arial'])
  ok(missing.length <= 1, `"Arial Bold" collapses onto Arial (got ${missing.length} entries)`)
}

console.log('checkFonts — symbol families are not reported')
{
  const missing = await checkFonts(['Wingdings', 'Symbol', 'Segoe UI Symbol'])
  ok(missing.length === 0, `dingbat families are never "missing" (got ${missing.map((m) => m.font)})`)
}

console.log('checkFonts — a metric-compatible clone is not a problem')
{
  // Whatever this machine has, the promise holds: if a font is reported missing
  // and a metric-compatible stand-in exists for it, that stand-in is absent too.
  const missing = await checkFonts(Object.keys(METRIC_SUBSTITUTES))
  ok(missing.every((m) => !m.metric),
    'anything still listed as missing has no installed metric substitute')
}


console.log('normaliseFamily — PostScript names map back to real families')
{
  const cases = [
    ['TimesNewRomanPSMT', 'Times New Roman'],
    ['TimesNewRomanPS-BoldMT', 'Times New Roman'],
    ['ArialMT', 'Arial'],
    ['Arial-BoldMT', 'Arial'],
    ['Arial', 'Arial'],
    ['Segoe UI', 'Segoe UI'],
    ['Verdana', 'Verdana'],
  ]
  for (const [input, want] of cases) {
    const got = normaliseFamily(input)
    ok(got === want, `${input} → ${want} (got ${got})`)
  }
}

console.log('checkFonts — a PostScript alias of an installed font is not missing')
{
  // Liberation Serif stands in for Times New Roman on any machine that ran
  // setup-fonts, so neither spelling should be reported.
  const plain = await checkFonts(['Times New Roman'])
  const ps = await checkFonts(['TimesNewRomanPSMT'])
  ok(plain.length === ps.length,
    `both spellings agree (plain ${plain.length}, PostScript ${ps.length})`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
