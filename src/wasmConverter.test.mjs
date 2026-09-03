// Tests for the parts of the in-website engine loader that are pure enough to
// run in Node: name candidates, gzip detection, and decompression. The full
// engine path is exercised end-to-end in a real browser (see README).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
globalThis.document ??= { baseURI: 'http://localhost/' }
const { candidateNames, isGzip, gunzip, DEFAULT_ENGINE_ASSETS } = await import('./wasmConverter.js')

test('big engine files try the compressed name first, then plain', () => {
  assert.deepEqual(candidateNames('soffice.wasm'), ['soffice.wasm.gz', 'soffice.wasm'])
  assert.deepEqual(candidateNames('soffice.data'), ['soffice.data.gz', 'soffice.data'])
})

test('scripts are only ever fetched under their own name', () => {
  assert.deepEqual(candidateNames('soffice.js'), ['soffice.js'])
  assert.deepEqual(candidateNames('soffice.worker.js'), ['soffice.worker.js'])
})

test('gzip is detected by content, not by filename', () => {
  const plain = new TextEncoder().encode('%PDF-1.7 not compressed')
  assert.equal(isGzip(plain), false)
  assert.equal(isGzip(new Uint8Array(gzipSync(plain))), true)
  assert.equal(isGzip(new Uint8Array([0x1f])), false) // too short to say
})

test('gunzip round-trips real gzip bytes', async () => {
  const original = new TextEncoder().encode('LibreOffice'.repeat(10_000))
  const out = await gunzip(new Uint8Array(gzipSync(original)))
  assert.deepEqual(out, original)
})

test('the built-in engine source is a pinned https directory', () => {
  // A "latest" tag could change the engine — and therefore a controlled
  // document's layout — without anyone deciding that. The default must name
  // an exact version, over https, ending in / so file names append cleanly.
  assert.match(DEFAULT_ENGINE_ASSETS, /^https:\/\//)
  assert.match(DEFAULT_ENGINE_ASSETS, /@\d+\.\d+\.\d+\//)
  assert.ok(DEFAULT_ENGINE_ASSETS.endsWith('/'))
})

// ---- the engine's stall guards -------------------------------------------

import { withStallLimit, EngineStalled, selfTestDocx, SELF_TEST_STALL_MS, FIRST_ATTEMPT_STALL_MS, STALL_LIMIT_MS } from './wasmConverter.js'
import JSZip from 'jszip'

test('withStallLimit passes a prompt result through', async () => {
  assert.equal(await withStallLimit(Promise.resolve(42), 1000), 42)
  await assert.rejects(withStallLimit(Promise.reject(new Error('boom')), 1000), /boom/)
})

test('withStallLimit gives up on a promise that never settles', async () => {
  const never = new Promise(() => {})
  await assert.rejects(withStallLimit(never, 20, undefined, () => 'quiet too long'),
    (e) => e instanceof EngineStalled && /quiet too long/.test(e.message))
})

test('withStallLimit measures from the last sign of life when given one', async () => {
  let last = Date.now()
  const keepAlive = setInterval(() => { last = Date.now() }, 5)
  // Quiet limit 40 ms, but activity every 5 ms: must NOT stall within 120 ms.
  const slowButAlive = new Promise((r) => setTimeout(() => r('ok'), 120))
  assert.equal(await withStallLimit(slowButAlive, 40, undefined, undefined, () => last), 'ok')
  clearInterval(keepAlive)
  // Activity that stops: stalls ~limit after the last report.
  const stuck = new Promise(() => {})
  const t0 = Date.now()
  await assert.rejects(withStallLimit(stuck, 40, undefined, undefined, () => last), (e) => e instanceof EngineStalled)
  assert.ok(Date.now() - t0 < 1500)
})

test('withStallLimit turns Cancel into an AbortError at once', async () => {
  const ctl = new AbortController()
  const p = withStallLimit(new Promise(() => {}), 10_000, ctl.signal)
  ctl.abort()
  await assert.rejects(p, (e) => e.name === 'AbortError')
  // And an already-aborted signal rejects without waiting.
  await assert.rejects(withStallLimit(new Promise(() => {}), 10_000, ctl.signal), (e) => e.name === 'AbortError')
})

test('the self-test document is a real, tiny .docx', async () => {
  const bytes = await selfTestDocx()
  assert.ok(bytes.length < 4000, `self-test docx is ${bytes.length} bytes`)
  const zip = await JSZip.loadAsync(bytes)
  assert.deepEqual(Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort(),
    ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
  assert.match(await zip.file('word/document.xml').async('string'), /self-test/)
  assert.equal(await selfTestDocx(), bytes) // built once, kept
})

test('the stall limits are ordered: self-test < first attempt < final', () => {
  assert.ok(SELF_TEST_STALL_MS < FIRST_ATTEMPT_STALL_MS)
  assert.ok(FIRST_ATTEMPT_STALL_MS < STALL_LIMIT_MS)
})
