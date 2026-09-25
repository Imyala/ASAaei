// Node test for tap-box cycles and answers carried between ways of answering.
// Run: node --test src/answers.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { STATUS_CYCLE, TICK_CYCLE, cycleFor, nextStatus, carryValue, answerKind } from './answers.js'

const tick = { type: 'status', options: ['✓', '✗'] }
const result = { type: 'status', options: [] }
const passFail = { type: 'status', options: ['Pass', 'N/A', 'Fail'] }
const done = { type: 'status', options: ['Done', 'Not Done'] }
const grade = { type: 'status', options: ['1', '2', '3', '4', '5'] }

test('a tick box taps tick, cross, clear — the second tap is a cross', () => {
  const cycle = cycleFor(tick)
  assert.equal(nextStatus('', cycle), '✓')
  assert.equal(nextStatus('✓', cycle), '✗')
  assert.equal(nextStatus('✗', cycle), '')
  // a hand-added tick box saved by the tick-only build ends up the same
  assert.equal(cycleFor({ type: 'status', options: ['✓'] }), TICK_CYCLE)
})

test('on Auto each box keeps its own cycle', () => {
  assert.equal(cycleFor(result), STATUS_CYCLE)
  assert.deepEqual(cycleFor(passFail), ['', 'Pass', 'N/A', 'Fail'])
  assert.deepEqual(cycleFor(done), ['', 'Done', 'Not Done'])
})

test('a page set to ticks or to OK / N/A / Fail makes every box answer that way', () => {
  for (const f of [tick, result, passFail, done, grade]) {
    assert.equal(cycleFor(f, 'tick'), TICK_CYCLE)
    assert.equal(cycleFor(f, 'status'), STATUS_CYCLE)
  }
})

test('answers follow a switch: a tick becomes OK, a cross Fail, and back', () => {
  assert.equal(carryValue('✓', STATUS_CYCLE), 'OK')
  assert.equal(carryValue('✗', STATUS_CYCLE), 'Fail')
  assert.equal(carryValue('OK', TICK_CYCLE), '✓')
  assert.equal(carryValue('Fail', TICK_CYCLE), '✗')
  // back to Auto: the column's own wording
  assert.equal(carryValue('✓', cycleFor(passFail)), 'Pass')
  assert.equal(carryValue('OK', cycleFor(passFail)), 'Pass')
  assert.equal(carryValue('✗', cycleFor(done)), 'Not Done')
  // typed answers count too
  assert.equal(carryValue('ok', TICK_CYCLE), '✓')
  assert.equal(carryValue('n/a', STATUS_CYCLE), 'N/A')
})

test('an answer with no counterpart is kept, never lost', () => {
  assert.equal(carryValue('N/A', TICK_CYCLE), 'N/A')
  assert.equal(carryValue('415.2', STATUS_CYCLE), '415.2')
  assert.equal(carryValue('415.2', TICK_CYCLE), '415.2')
  assert.equal(carryValue('3', STATUS_CYCLE), '3')
  assert.equal(carryValue('✓', cycleFor(grade)), '✓')
  assert.equal(carryValue('', TICK_CYCLE), '')
  assert.equal(answerKind('Checked the oil'), '')
})
