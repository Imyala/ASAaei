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
  // A label that asks for a figure: a unit, a quantity, a grading. Such a box
  // is typed into, never tapped OK / N/A / Fail, however narrow it is.
  reading: /reading|value|measure|grad(?:e|ing)|score|rating|level|qty|quantity|count|hours|time\b|load|pressure|temp|speed|flow|litres?|\bl\b|kpa|bar\b|psi|°|deg|volt|\bv\b|amp|\ba\b|\bhz\b|rpm|\bkva?\b|\bkw\b|\bmm\b|\bm\b|\bkg\b|%/i,
}

export const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()

// Footnote marks trailing a heading ("1M±", "3M**", "Result†").
const stripMarks = (s) => s.replace(/[*±†‡#^~+]+$/, '')

// Classify a column/header label. Returns 'status' | 'text' | ''.
export function classifyHeader(text) {
  const t = norm(text)
  if (!t) return ''
  if (RX.remarks.test(t)) return 'text'
  if (RX.freq.test(stripMarks(t.replace(/\s/g, '')))) return 'status'
  if (RX.status.test(t)) return 'status'
  if (RX.textish.test(t)) return 'text'
  return ''
}

// True for a single token that on its own marks a status/result column
// (a frequency code like "3M"/"1Y", or an OK/Fail/N/A word).
//
// A frequency code often carries a footnote mark — "1M±", "3M**", "6M†" —
// pointing at a note under the table. The mark is dropped before matching:
// with it, the Day Tank table's 1M and 3M columns read as ordinary text
// columns and got typing boxes instead of OK / N/A / Fail tap-cells.
export function isStatusToken(text) {
  const t = stripMarks(norm(text).replace(/\s/g, ''))
  if (!t) return false
  if (RX.freq.test(t)) return true
  return /^(ok|fail|n\/?a|pass|result)$/i.test(t)
}

// True for a token that heads a Remarks/Comments column.
export function isRemarksToken(text) {
  return RX.remarks.test(norm(text))
}

// True for a token that can ONLY be a column heading, never a filled-in value.
//
// The distinction matters because header rows must not receive fields. A lone
// "Pass" or "OK" is ambiguous — it heads a column in a blank form and is an
// answer in a completed one — but the paired forms ("Pass/Fail", "OK / Fail")
// and the title words ("Result", "Status") are printed captions in every case.
// Judging a header on these alone means re-opening a part-filled form cannot
// mistake its own answers for headings.
//
// The paired forms include "OK/Not OK" (the fuel procedure's "Result OK/Not
// OK" column), "OK/NOK" and "Yes/No".
//
// A longer heading that ENDS in a paired form ("Fuel Inventory Verified
// Yes/No") is one too, and "Results" heads a column as "Result" does.
const RX_STATUS_HEADER =
  /^(?:[a-z]+\s+)?(?:ok|pass|yes)\s*\/\s*(?:fail|n\/?a|not\s*ok|nok|no)\b|^(?:results?|status|condition|outcome)$|(?:^|\s)(?:yes\s*\/\s*no|ok\s*\/\s*not\s*ok|pass\s*\/\s*fail)$/i

export function isStatusHeaderToken(text) {
  return RX_STATUS_HEADER.test(norm(text))
}

// True for a row or column label that asks for a figure to be written in —
// "Voltage (R): Volts", "Oil Press. Main: kPa", "Actual Reading", "Grading
// (1-5)" — as opposed to a task to be checked off. Kept to label-length text
// so a sentence that merely mentions a temperature does not count.
export function isReadingLabel(text) {
  const t = norm(text)
  if (!t || t.length > 48) return false
  return RX.reading.test(t)
}
