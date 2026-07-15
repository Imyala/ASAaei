// Document identity — how the app recognises "this is the same form again".
//
// Official inspection forms carry a stable document number (e.g. "AEI 3.4106")
// that survives version/date changes. We key a saved field layout to that
// number, so the next time the tech opens that form — no matter the version —
// the app re-applies the layout automatically and drops them into fill mode.
// If there's no AEI number we fall back to a normalised title/filename.

export function extractIdentity(text, fallbackName = '') {
  const t = (text || '').replace(/[   ]/g, ' ')

  // Primary key: an AEI document number like "AEI 3.4106" / "AEI3-4106".
  const m = t.match(/\bAEI[\s-]*([0-9]+(?:[.\-][0-9]+)+)/i)
  const title = findTitle(t) || fallbackName.replace(/\.(pdf|docx)$/i, '').trim()

  let docKey = ''
  if (m) docKey = 'AEI ' + m[1].replace(/-/g, '.')
  else docKey = normKey(title)

  return { docKey, docTitle: title || docKey }
}

// A short human title for display — prefer an "Appendix X …" heading, else the
// longest early line that isn't boilerplate.
function findTitle(t) {
  const appendix = t.match(/Appendix\s+[A-Z]\b[^\n]{0,70}/i)
  if (appendix) return norm(appendix[0])
  const lines = t.split(/\n+/).map((s) => norm(s)).filter(Boolean)
  let best = ''
  for (const line of lines.slice(0, 20)) {
    if (/^official$/i.test(line) || /^version\b/i.test(line)) continue
    const letters = (line.match(/[A-Za-z]/g) || []).length
    if (letters >= 12 && line.length > best.length && line.length < 90) best = line
  }
  return best
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
const normKey = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
