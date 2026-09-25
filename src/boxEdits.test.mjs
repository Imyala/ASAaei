// Node test for the hand-edit change list. Run: node --test src/boxEdits.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffBoxEdits, applyBoxEdits, sameBox } from './boxEdits.js'

const box = (id, page, x, y, w = 0.05, h = 0.02, type = 'text', options = []) =>
  ({ id, page, type, options, xPct: x, yPct: y, wPct: w, hPct: h, label: id, value: '' })

test('a removed, a moved and an added box are all recorded', () => {
  const base = [box('a', 0, 0.1, 0.1), box('b', 0, 0.3, 0.1), box('c', 1, 0.1, 0.5)]
  const current = [
    { ...base[0], value: 'typed' },            // kept (a value is not an edit)
    { ...base[2], xPct: 0.2 },                 // moved
    box('n1', 1, 0.6, 0.6, 0.02, 0.015, 'status', ['✓']), // added tick
  ]
  const d = diffBoxEdits(base, current, 2)
  assert.equal(d.pageCount, 2)
  assert.equal(d.removed.length, 2, 'b removed, c moved away')
  assert.equal(d.added.length, 2, 'c in its new place, and the new tick')
  assert.ok(d.added.every((f) => f.value === '' && !('id' in f)), 'layouts only, no values or ids')
})

test('edits re-apply to fresh detection, and only to the same document', () => {
  const base = [box('a', 0, 0.1, 0.1), box('b', 0, 0.3, 0.1)]
  const edits = diffBoxEdits(base, [base[0], box('n', 0, 0.5, 0.5)], 3)
  // detection runs again: same boxes, new ids, a hair of jitter
  const fresh = [box('x', 0, 0.1005, 0.1), box('y', 0, 0.3004, 0.1002)]
  let n = 0
  const { fields, applied } = applyBoxEdits(fresh, edits, 3, () => `new${n++}`)
  assert.ok(applied)
  assert.deepEqual(fields.map((f) => f.id).sort(), ['new0', 'x'])
  assert.equal(applyBoxEdits(fresh, edits, 4, () => 'z').applied, false, 'another page count: left alone')
})

test('sameBox tells the same box from a neighbour', () => {
  assert.ok(sameBox(box('a', 0, 0.1, 0.1), box('b', 0, 0.101, 0.1)))
  assert.ok(!sameBox(box('a', 0, 0.1, 0.1), box('b', 0, 0.16, 0.1)), 'the next cell along')
  assert.ok(!sameBox(box('a', 0, 0.1, 0.1), box('b', 1, 0.1, 0.1)), 'another page')
})
