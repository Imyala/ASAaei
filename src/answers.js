// What a tap box cycles through, and how an answer already given follows a
// switch between ticks, OK / N/A / Fail and typing. Pure functions over field
// objects ({ type: 'status', options, value }), so they are unit-tested.

// Tri-state tap control: blank → OK → N/A → Fail → blank.
//
// A field may carry its own wording in `options` — a column headed "Pass/Fail"
// taps through Pass / N/A / Fail — so the value written onto the form is the
// one the form itself asks for. No options means this default.
export const STATUS_CYCLE = ['', 'OK', 'N/A', 'Fail']
// A tick box: tick, cross, clear.
export const TICK_CYCLE = ['', '✓', '✗']

// A printed tick box ("☐") taps tick → cross → clear.
export function isTickField(f) { return f?.type === 'status' && f.options?.[0] === '✓' }

// What a tap box cycles through on a page whose boxes answer the `mode` way:
// '' (Auto) is the box's own cycle, 'tick' ticks and crosses, 'status'
// OK / N/A / Fail. ('type' has no cycle: the box is typed into.)
export const cycleFor = (f, mode = '') =>
  (mode === 'tick' ? TICK_CYCLE
    // a tick column that also offers N/A ("√ / X- N/A") taps through it too
    : !mode && isTickField(f) ? (f.options.length > 2 ? ['', ...f.options] : TICK_CYCLE)
      : mode === 'status' || !f?.options?.length ? STATUS_CYCLE
        : ['', ...f.options])

export const nextStatus = (v, cycle = STATUS_CYCLE) =>
  cycle[(cycle.indexOf(v) + 1) % cycle.length]

// What an answer means whatever its wording: 'yes' (OK, Pass, Done, ✓), 'no'
// (Fail, Not Done, ✗), 'na', or '' for anything else — a typed figure, a grade.
export function answerKind(v) {
  const s = String(v ?? '').trim()
  if (/^(ok|pass|yes|done|✓|✔)$/i.test(s)) return 'yes'
  if (/^(fail|no|not .+|✗|✘)$/i.test(s)) return 'no'
  if (/^n\/?a$/i.test(s)) return 'na'
  return ''
}

// An answer already given, carried into another way of answering: a tick
// becomes OK (or the column's "Pass", "Yes"), a cross Fail, and back again.
// One with no counterpart — N/A as a tick, a typed figure — stays as it is.
export function carryValue(v, cycle) {
  if (!v || cycle.includes(v)) return v
  const kind = answerKind(v)
  return (kind && cycle.find((c) => answerKind(c) === kind)) || v
}
