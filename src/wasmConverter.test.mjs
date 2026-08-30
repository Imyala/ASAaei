// Tests for the parts of the in-website engine loader that are pure enough to
// run in Node: name candidates, gzip detection, and decompression. The full
// engine path is exercised end-to-end in a real browser (see README).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { candidateNames, isGzip, gunzip, DEFAULT_ENGINE_ASSETS } from './wasmConverter.js'

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
