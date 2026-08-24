#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ASAaei conversion server
// ---------------------------------------------------------------------------
// One command that does two things:
//
//   • serves the built app (dist/) as a normal web site, and
//   • exposes /api/convert, backed by a warm LibreOffice pool.
//
// Serving both from the SAME ORIGIN is deliberate: the app finds the converter
// at its own address with no configuration, no CORS pre-flight, and no setting
// for anyone to get wrong. An iPad just opens http://<this-machine>:8787 and
// high-fidelity conversion is already on.
//
//   npm run serve                 # build first, then serve app + converter
//   node server/convert-server.mjs --port 8787 --host 0.0.0.0
//
// Nothing is stored: uploads live in a temp file for the length of the
// conversion and are deleted in a `finally`. Converted PDFs are kept only in an
// in-memory cache so re-opening the same form is instant.

import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConverterPool, QUALITY_PRESETS } from './libreoffice.mjs'
import { fontReport } from './fonts.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port || process.env.PORT || 8787)
const HOST = args.host || process.env.HOST || '0.0.0.0'
const STATIC_DIR = path.resolve(args.static || process.env.STATIC_DIR || path.join(ROOT, 'dist'))
const MAX_UPLOAD = Number(args['max-upload'] || process.env.MAX_UPLOAD || 80) * 1024 * 1024
const POOL_SIZE = Number(args.workers || process.env.WORKERS || 0) || undefined

const log = (msg) => console.log(`[asaaei] ${msg}`)

const pool = new ConverterPool({ size: POOL_SIZE, onLog: log })

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
}

// The app may be opened from a different origin than the converter (a tablet
// running the hosted PWA against an office machine's converter), so the API is
// CORS-open. It only ever converts a document the caller supplied and hands it
// straight back — there is no account, no stored data and nothing to read.
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Quality')
  res.setHeader('Access-Control-Expose-Headers',
    'X-Convert-Ms, X-Convert-Cached, X-Convert-Engine, X-Convert-Pages, X-Convert-Missing-Fonts')
  res.setHeader('Access-Control-Max-Age', '86400')
}

const sendJson = (res, code, body) => {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

const server = http.createServer(async (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const route = url.pathname.replace(/\/+$/, '') || '/'

  try {
    // The app probes this to decide whether high-fidelity conversion is on.
    if (route === '/api/health') {
      const fonts = await fontReport().catch(() => null)
      sendJson(res, 200, { app: 'asaaei-converter', version: 1, ...pool.health(), fonts })
      return
    }
    if (route === '/api/convert') {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST a document to this endpoint' }); return }
      await handleConvert(req, res, url)
      return
    }
    if (route.startsWith('/api/')) { sendJson(res, 404, { error: 'unknown endpoint' }); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'method not allowed' }); return }
    await serveStatic(route, req, res)
  } catch (err) {
    log(`error on ${route}: ${err.stack || err.message}`)
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'server error' })
    else res.end()
  }
})

async function handleConvert(req, res, url) {
  const filename = decodeURIComponent(
    req.headers['x-filename'] || url.searchParams.get('name') || 'document.docx')
  const quality = String(req.headers['x-quality'] || url.searchParams.get('quality') || 'balanced')
  if (!QUALITY_PRESETS[quality]) {
    sendJson(res, 400, { error: `unknown quality "${quality}". Use one of: ${Object.keys(QUALITY_PRESETS).join(', ')}` })
    return
  }
  if (!pool.available) {
    sendJson(res, 503, { error: pool.error || 'the converter is not available', mode: pool.mode })
    return
  }

  let body
  try {
    body = await readBody(req, MAX_UPLOAD)
  } catch (err) {
    sendJson(res, err.tooLarge ? 413 : 400, { error: err.message })
    return
  }
  if (!body.length) { sendJson(res, 400, { error: 'the request body was empty' }); return }

  // The client posts raw bytes (fetch with the File as the body), but accept a
  // multipart form too so the endpoint works from curl and a plain HTML form.
  const ct = String(req.headers['content-type'] || '')
  const payload = ct.startsWith('multipart/form-data')
    ? extractMultipartFile(body, ct) || { bytes: body, filename }
    : { bytes: body, filename }

  const started = Date.now()
  try {
    const out = await pool.convert(payload.bytes, payload.filename || filename, { quality })
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': out.bytes.length,
      'Content-Disposition':
        `inline; filename="${asciiFilename(payload.filename || filename).replace(/\.[^.]+$/, '')}.pdf"`,
      'Cache-Control': 'no-store',
      'X-Convert-Ms': String(out.ms),
      'X-Convert-Cached': out.cached ? '1' : '0',
      'X-Convert-Pages': String(out.pages || 0),
      'X-Convert-Engine': pool.version || 'LibreOffice',
      // Fonts the document asked for that this machine does not have. The app
      // surfaces these so a layout that shifted has a visible explanation
      // rather than looking like a converter bug. Capped: a header has a size
      // limit, and a list this long is already telling the whole story.
      'X-Convert-Missing-Fonts': (out.missingFonts || []).slice(0, 12)
        .map((f) => f.font).join(', '),
    })
    res.end(out.bytes)
    log(`converted ${payload.filename || filename} (${fmtBytes(payload.bytes.length)} -> `
      + `${fmtBytes(out.bytes.length)}) in ${out.cached ? 'cache hit' : `${Date.now() - started} ms`}`)
  } catch (err) {
    log(`conversion failed for ${payload.filename || filename}: ${err.message}`)
    sendJson(res, 422, { error: err.message || 'the document could not be converted' })
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        const err = new Error(`the file is larger than the ${Math.round(limit / 1048576)} MB limit`)
        err.tooLarge = true
        reject(err)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Minimal multipart reader: pull the first file part out of the body. Enough
// for `curl -F file=@form.docx`; the app itself posts raw bytes.
function extractMultipartFile(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) return null
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim())
  let start = body.indexOf(boundary)
  while (start >= 0) {
    const headerStart = start + boundary.length
    const headerEnd = body.indexOf('\r\n\r\n', headerStart)
    if (headerEnd < 0) return null
    const headers = body.slice(headerStart, headerEnd).toString('latin1')
    const next = body.indexOf(boundary, headerEnd)
    if (next < 0) return null
    const nameMatch = /filename\*?=(?:"([^"]*)"|([^\s;]+))/i.exec(headers)
    if (nameMatch) {
      // Trim the CRLF that precedes the closing boundary.
      const bytes = body.slice(headerEnd + 4, next - 2)
      return { bytes, filename: (nameMatch[1] || nameMatch[2] || 'document.docx').replace(/^.*[\\/]/, '') }
    }
    start = next
  }
  return null
}

// ---------------------------------------------------------------------------
// Static hosting of the built app
// ---------------------------------------------------------------------------

async function serveStatic(route, req, res) {
  const rel = decodeURIComponent(route).replace(/^\/+/, '')
  // Resolve inside STATIC_DIR and verify it stayed there, so "../" in a URL
  // can never reach outside the published folder.
  const target = path.resolve(STATIC_DIR, rel)
  const inside = target === STATIC_DIR || target.startsWith(STATIC_DIR + path.sep)

  let file = inside ? target : null
  let stat = file ? await fs.stat(file).catch(() => null) : null
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html')
    stat = await fs.stat(file).catch(() => null)
  }
  if (!stat?.isFile()) {
    // Single-page app: unknown paths fall through to index.html.
    file = path.join(STATIC_DIR, 'index.html')
    stat = await fs.stat(file).catch(() => null)
  }
  if (!stat?.isFile()) {
    sendJson(res, 404, {
      error: 'the app has not been built yet',
      hint: `Run "npm run build" (expected files in ${STATIC_DIR}). The converter API at /api/convert works regardless.`,
    })
    return
  }

  const ext = path.extname(file).toLowerCase()
  // Vite emits content-hashed asset filenames, so those are safe to cache hard;
  // everything else must revalidate or a redeploy serves a stale shell.
  const hashed = /\/assets\/.+\.[0-9a-f]{8,}\.[a-z0-9]+$/i.test(file.replace(/\\/g, '/'))
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(await fs.readFile(file))
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i]
    else out[a.slice(2)] = 'true'
  }
  return out
}

const fmtBytes = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`)
// Content-Disposition is a latin-1 header; strip anything that would break it.
const asciiFilename = (name) => String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')

// Every LAN address this machine answers on, so the operator can read the URL
// to type into a tablet straight off the console.
function lanUrls(port) {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`)
    }
  }
  return out
}

server.listen(PORT, HOST, async () => {
  log(`serving on http://localhost:${PORT}`)
  for (const u of lanUrls(PORT)) log(`  on this network: ${u}`)
  log(`app files: ${STATIC_DIR}`)
  log('starting LibreOffice…')
  await pool.init()
  const h = pool.health()
  if (h.ok) {
    log(`converter ready — ${h.engine}, ${h.workers} worker(s), `
      + `${h.warm ? 'warm (sub-second)' : 'cold-start per job'}`)
  } else {
    log(`converter UNAVAILABLE: ${h.error}`)
    log('the app still runs; it will fall back to in-browser conversion')
  }
})

const shutdown = () => {
  log('shutting down…')
  pool.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
