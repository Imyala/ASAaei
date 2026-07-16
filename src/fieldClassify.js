// Shared field-classification helpers used by both the Word (.docx) table
// reader (convert.js) and the PDF text-grid reader (pdfFields.js). Keeping the
// rules in one place means a column that reads as "status" in a Word doc reads
// the same way in a PDF.

export const OK_FAIL_NA = ['OK', 'N/A', 'Fail']

const RX = {
  remarks: /remark|comment|note|observation|action|finding/i,
  status: /\b(ok\s*\/?\s*fail|pass\s*\/?\s*fail|result|status|condition|inspect|check)\b|\bok\b|\bfail\b|\bn\/?a\b/i,
  // maintenance frequency codes: 1M 3M 6M 12M 1Y, or single D/W/M/Q/Y
  freq: /^(?:\d{1,2}\s*[dwmqy]|[dwmqy])$/i,
  textish: /model|serial|barcode|calibrat|reading|value|measure|number|no\.?$|name|hours|pressure|temp|date|site|order|plan|cert|sheet/i,
}

export const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()

// Classify a column/header label. Returns 'status' | 'text' | ''.
export function classifyHeader(text) {
  const t = norm(text)
  if (!t) return ''
  if (RX.remarks.test(t)) return 'text'
  if (RX.freq.test(t.replace(/\s/g, ''))) return 'status'
  if (RX.status.test(t)) return 'status'
  if (RX.textish.test(t)) return 'text'
  return ''
}

// True for a single token that on its own marks a status/result column
// (a frequency code like "3M"/"1Y", or an OK/Fail/N/A word).
export function isStatusToken(text) {
  const t = norm(text).replace(/\s/g, '')
  if (!t) return false
  if (RX.freq.test(t)) return true
  return /^(ok|fail|n\/?a|pass|result)$/i.test(t)
}

// True for a token that heads a Remarks/Comments column.
export function isRemarksToken(text) {
  return RX.remarks.test(norm(text))
}
