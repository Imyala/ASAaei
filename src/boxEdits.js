// Boxes the tech adds, removes, moves or retypes by hand, kept as a change
// list over what detection finds rather than as a frozen layout.
//
// Detection re-runs on every open, so a re-issued form still fills. The
// tech's fixes ride on top of it: a box they removed is removed again when
// detection finds it (the same place on the same page), and a box they added
// is added again. A different document — another page count — gets neither.
//
// Pure functions over field objects ({ id, page, type, options, xPct, yPct,
// wPct, hPct, label }), so they are unit-tested in Node.

const EPS = 0.0015 // a page fraction: well under a point on A4

const rectOf = (f) => ({ page: f.page, xPct: f.xPct, yPct: f.yPct, wPct: f.wPct, hPct: f.hPct })

// The same box: same page, overlapping most of the smaller one, and not
// wildly different in size.
export function sameBox(a, b) {
  if (a.page !== b.page) return false
  const ox = Math.min(a.xPct + a.wPct, b.xPct + b.wPct) - Math.max(a.xPct, b.xPct)
  const oy = Math.min(a.yPct + a.hPct, b.yPct + b.hPct) - Math.max(a.yPct, b.yPct)
  if (ox <= 0 || oy <= 0) return false
  const aa = a.wPct * a.hPct, ba = b.wPct * b.hPct
  return ox * oy >= 0.7 * Math.min(aa, ba) && Math.min(aa, ba) >= 0.5 * Math.max(aa, ba)
}

// Whether a box was moved, resized or retyped.
function changed(a, b) {
  return Math.abs(a.xPct - b.xPct) > EPS || Math.abs(a.yPct - b.yPct) > EPS
    || Math.abs(a.wPct - b.wPct) > EPS || Math.abs(a.hPct - b.hPct) > EPS
    || a.type !== b.type || (a.options || []).join('|') !== (b.options || []).join('|')
}

// The layout of a field without what was typed into it.
function layoutOf(f) {
  const { id, value, auto, ...rest } = f
  return { ...rest, value: f.type === 'signature' ? null : '' }
}

// What the tech changed: `base` is the detected fields as the document
// opened (before any saved edits), `current` the fields now.
//
// A tick or cross dropped on the page is an answer, not a box, so it is not
// part of the form's layout.
export function diffBoxEdits(base, allCurrent, pageCount) {
  const current = allCurrent.filter((f) => f.type !== 'mark')
  const now = new Map(current.map((f) => [f.id, f]))
  const before = new Map(base.map((f) => [f.id, f]))
  const removed = []
  const added = []
  for (const b of base) {
    const c = now.get(b.id)
    if (!c || changed(b, c)) removed.push(rectOf(b))
  }
  for (const c of current) {
    const b = before.get(c.id)
    if (!b || changed(b, c)) added.push(layoutOf(c))
  }
  return { pageCount, added, removed }
}

export const hasBoxEdits = (edits) => !!edits && ((edits.added || []).length > 0 || (edits.removed || []).length > 0)

// Re-apply saved edits to freshly detected fields. `makeId` gives each added
// box a new id. Returns the fields and whether the edits applied.
export function applyBoxEdits(detected, edits, pageCount, makeId) {
  if (!hasBoxEdits(edits) || edits.pageCount !== pageCount) return { fields: detected, applied: false }
  const removed = edits.removed || []
  const kept = detected.filter((f) => !removed.some((r) => sameBox(r, f)))
  const added = (edits.added || [])
    .filter((f) => f.page >= 0 && f.page < pageCount)
    .map((f) => ({ ...f, id: makeId(), value: f.type === 'signature' ? null : '' }))
  return { fields: [...kept, ...added], applied: true }
}
