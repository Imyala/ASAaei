// ---------------------------------------------------------------------------
// LibreOffice conversion engine
// ---------------------------------------------------------------------------
// Turns Word (and RTF/ODT/HTML/TXT) into PDF with LibreOffice's own Writer
// layout engine, which is the only open-source engine that reads .docx with
// full fidelity: real fonts, exact table geometry, headers/footers, page
// breaks, floating images. The output is a *vector* PDF — selectable text and
// real ruled lines — not a picture of the document.
//
// Speed is the other half of the job. Two things make it quick:
//
//   1. A WARM POOL. `soffice --convert-to pdf` costs ~1.2-1.5 s of process
//      start-up per document. We instead keep N LibreOffice processes running
//      with a UNO listener and hand them jobs over a socket, so start-up is
//      paid once when the server boots. Typical inspection form: ~0.4-0.8 s.
//   2. A CONTENT CACHE. The same form gets opened over and over, so the PDF is
//      keyed by the SHA-256 of the source bytes plus the export options.
//      A repeat conversion returns in single-digit milliseconds.
//
// If python3-uno is not installed, the pool degrades to spawning the CLI per
// job. Slower, but it still converts, so the server is never dead in the water.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFonts, fontsUsedInDocx } from './fonts.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PY = path.join(HERE, 'uno-worker.py')

// Extensions we accept, mapped to the LibreOffice export filter that produces a
// PDF from that document type. Writer covers everything the app deals with.
export const INPUT_FILTERS = {
  '.docx': 'writer_pdf_Export',
  '.doc': 'writer_pdf_Export',
  '.docm': 'writer_pdf_Export',
  '.dotx': 'writer_pdf_Export',
  '.rtf': 'writer_pdf_Export',
  '.odt': 'writer_pdf_Export',
  '.fodt': 'writer_pdf_Export',
  '.txt': 'writer_pdf_Export',
  '.html': 'writer_pdf_Export',
  '.htm': 'writer_pdf_Export',
}

// PDF export presets. `balanced` is the default: images are re-encoded at
// 300 dpi / quality 90, which is indistinguishable on screen and in print for
// scanned logos and photos but produces a PDF 3-5x smaller than lossless — and
// a smaller PDF renders faster in the app and downloads faster to a tablet.
// Text, tables and lines are vector in every preset, so "formatting" is never
// what these options trade away.
export const QUALITY_PRESETS = {
  // Screen/tablet: smallest file, still sharp at 100% zoom.
  fast: {
    UseLosslessCompression: false, Quality: 80,
    ReduceImageResolution: true, MaxImageResolution: 150,
  },
  // The default. 300 dpi is print resolution, so a printed form is unchanged.
  balanced: {
    UseLosslessCompression: false, Quality: 90,
    ReduceImageResolution: true, MaxImageResolution: 300,
  },
  // Untouched images plus a tagged structure tree, for a file that has to be
  // archived or read by a screen reader. Measurably the largest of the three —
  // on our sample forms tagging alone roughly triples the PDF — which is why it
  // is opt-in rather than the default.
  archive: {
    UseLosslessCompression: true,
    ReduceImageResolution: false,
    UseTaggedPDF: true,
  },
}

// Options shared by every preset.
//
// Note what is NOT here: `UseTaggedPDF`. Tagging changes no pixel of the output
// — it only adds a structure tree — but on the sample inspection forms it took
// a 290 KB PDF to 820 KB. A smaller PDF renders faster in the app and downloads
// faster to a tablet, and nothing in the app's field detection reads tags (it
// works off text positions and drawn lines), so tagging is left to `archive`.
const COMMON_FILTER_DATA = {
  ExportBookmarks: true,
  ExportNotes: false,
  IsSkipEmptyPages: false, // a blank page in the form is still a page to fill
}

// ---------------------------------------------------------------------------
// Locating LibreOffice
// ---------------------------------------------------------------------------

const WIN_DIRS = [
  'C:/Program Files/LibreOffice/program',
  'C:/Program Files (x86)/LibreOffice/program',
]
const MAC_DIRS = [
  '/Applications/LibreOffice.app/Contents/MacOS',
]

const exists = (p) => fs.access(p).then(() => true, () => false)

// Find the `soffice` binary. Honours SOFFICE_PATH first so an unusual install
// can be pointed at explicitly, then checks the platform's normal locations,
// then falls back to whatever is on PATH.
export async function findSoffice() {
  const candidates = []
  if (process.env.SOFFICE_PATH) candidates.push(process.env.SOFFICE_PATH)
  if (process.platform === 'win32') {
    for (const d of WIN_DIRS) candidates.push(path.join(d, 'soffice.exe'))
  } else if (process.platform === 'darwin') {
    for (const d of MAC_DIRS) candidates.push(path.join(d, 'soffice'))
    candidates.push('/usr/local/bin/soffice', '/opt/homebrew/bin/soffice')
  } else {
    candidates.push('/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice',
      '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice')
  }
  for (const c of candidates) if (await exists(c)) return c
  // Last resort: trust PATH. If it isn't there either, the first spawn fails
  // with a clear ENOENT that the caller reports.
  return process.platform === 'win32' ? 'soffice.exe' : 'soffice'
}

// Find a python that can `import uno`. On Windows and macOS the interpreter
// that ships inside LibreOffice is the only one wired up for it; on Linux the
// python3-uno package puts it on the system python.
export async function findUnoPython(sofficePath) {
  const dir = path.dirname(sofficePath)
  const candidates = []
  if (process.env.UNO_PYTHON) candidates.push(process.env.UNO_PYTHON)
  if (process.platform === 'win32') candidates.push(path.join(dir, 'python.exe'))
  else candidates.push(path.join(dir, 'python'))
  candidates.push('python3', 'python')

  for (const c of candidates) {
    if (c.includes(path.sep) && !(await exists(c))) continue
    if (await canImportUno(c)) return c
  }
  return null
}

function canImportUno(python) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let child
    try {
      child = spawn(python, ['-c', 'import uno'], { stdio: 'ignore' })
    } catch { finish(false); return }
    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
    setTimeout(() => { try { child.kill() } catch {} ; finish(false) }, 10_000)
  })
}

// ---------------------------------------------------------------------------
// One warm LibreOffice instance + its UNO worker
// ---------------------------------------------------------------------------
// Each engine owns a private user profile directory and a private port, because
// two LibreOffice processes sharing a profile refuse to start ("another
// instance is already running"). Separate profiles are what makes real
// concurrency possible.

class Engine {
  constructor({ id, port, soffice, python, profileRoot, jobTimeoutMs, onLog }) {
    this.id = id
    this.port = port
    this.soffice = soffice
    this.python = python
    this.profileDir = path.join(profileRoot, `profile-${id}`)
    this.jobTimeoutMs = jobTimeoutMs
    this.onLog = onLog || (() => {})
    this.busy = false
    this.ready = false
    this.pending = null // { resolve, reject, timer }
    this.seq = 0
    this.stopping = false
    this.readyPromise = null
  }

  log(msg) { this.onLog(`engine ${this.id}: ${msg}`) }

  async start() {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this._start().catch((err) => {
      this.readyPromise = null
      throw err
    })
    return this.readyPromise
  }

  async _start() {
    await fs.mkdir(this.profileDir, { recursive: true })
    const profileUrl = pathToFileUrl(this.profileDir)

    this.office = spawn(this.soffice, [
      '--headless', '--invisible', '--nodefault', '--nologo',
      '--nolockcheck', '--norestore', '--nofirststartwizard',
      `-env:UserInstallation=${profileUrl}`,
      `--accept=socket,host=127.0.0.1,port=${this.port};urp;`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    this.office.stderr?.on('data', (d) => {
      const s = String(d).trim()
      // javaldx warns on every start of a JRE-less install and means nothing
      // for our conversions — don't scare the operator with it.
      if (s && !/javaldx/i.test(s)) this.log(`soffice: ${s}`)
    })
    this.office.on('exit', (code) => {
      if (!this.stopping) this.log(`LibreOffice exited (code ${code}) — will restart on next job`)
      this._teardown(new Error('LibreOffice stopped unexpectedly'))
    })

    this.worker = spawn(this.python, [WORKER_PY, String(this.port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.worker.stderr?.on('data', (d) => {
      const s = String(d).trim()
      if (s) this.log(s.replace(/^\[uno-worker\]\s*/, ''))
    })
    this.worker.on('exit', () => {
      if (!this.stopping) this.log('UNO worker exited — will restart on next job')
      this._teardown(new Error('the conversion worker stopped'))
    })

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('LibreOffice did not become ready in time')),
        120_000,
      )
      readLines(this.worker.stdout, (line) => {
        let msg
        try { msg = JSON.parse(line) } catch { return }
        if (msg.ready) {
          clearTimeout(timer)
          this.ready = true
          resolve()
          return
        }
        this._settle(msg)
      })
      this.worker.on('error', (err) => { clearTimeout(timer); reject(err) })
      this.worker.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`the conversion worker exited during start-up (code ${code})`))
      })
    })
    this.log(`ready on port ${this.port}`)
  }

  _settle(msg) {
    const p = this.pending
    if (!p) return
    this.pending = null
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg)
    else p.reject(new Error(msg.error || 'conversion failed'))
  }

  // Drop the running processes and fail whatever job was in flight. The engine
  // is restartable afterwards — `start()` builds a fresh pair.
  _teardown(err) {
    this.ready = false
    this.readyPromise = null
    const p = this.pending
    if (p) {
      this.pending = null
      clearTimeout(p.timer)
      p.reject(err)
    }
    for (const proc of [this.worker, this.office]) {
      try { proc?.kill() } catch { /* already gone */ }
    }
    this.worker = null
    this.office = null
  }

  // `busy` belongs to the pool — it reserves an engine before calling this and
  // clears the flag in its own `finally`. The in-flight guard here is
  // `this.pending`, which is this engine's own view of the same fact.
  async convert(job) {
    if (!this.ready) await this.start()
    if (this.pending) throw new Error('engine already has a job in flight')
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A document that hangs LibreOffice (a modal we failed to suppress, a
        // pathological layout) would otherwise wedge this engine for good, so
        // tear it down and let the pool restart it for the next job.
        this.log('job timed out — restarting LibreOffice')
        this._teardown(new Error('the document took too long to convert'))
      }, this.jobTimeoutMs)
      this.pending = { resolve, reject, timer }
      try {
        this.worker.stdin.write(JSON.stringify({ ...job, id }) + '\n')
      } catch (err) {
        clearTimeout(timer)
        this.pending = null
        this.busy = false
        reject(err)
      }
    })
  }

  stop() {
    this.stopping = true
    this._teardown(new Error('server shutting down'))
  }
}

// ---------------------------------------------------------------------------
// CLI fallback engine (no python3-uno)
// ---------------------------------------------------------------------------

class CliEngine {
  constructor({ id, soffice, profileRoot, jobTimeoutMs, onLog }) {
    this.id = id
    this.soffice = soffice
    this.profileDir = path.join(profileRoot, `cli-profile-${id}`)
    this.jobTimeoutMs = jobTimeoutMs
    this.onLog = onLog || (() => {})
    this.busy = false
    this.ready = true
  }

  async start() { await fs.mkdir(this.profileDir, { recursive: true }) }

  // As with the UNO engine, `busy` is the pool's flag, not ours.
  async convert(job) {
    const outDir = path.dirname(job.out)
    // The CLI names the output after the input, so convert into a scratch
    // directory and move the result to the exact path the caller asked for.
    const args = [
      '--headless', '--invisible', '--nodefault', '--nologo',
      '--nolockcheck', '--norestore',
      `-env:UserInstallation=${pathToFileUrl(this.profileDir)}`,
      '--convert-to', 'pdf:' + (job.filter || 'writer_pdf_Export'),
      '--outdir', outDir, job.src,
    ]
    const started = Date.now()
    await runOnce(this.soffice, args, this.jobTimeoutMs)
    const produced = path.join(
      outDir, path.basename(job.src, path.extname(job.src)) + '.pdf')
    if (produced !== job.out) await fs.rename(produced, job.out)
    return { ok: true, ms: Date.now() - started, pages: 0 }
  }

  stop() {}
}

function runOnce(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr?.on('data', (d) => { err += d })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error('the document took too long to convert'))
    }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(err.trim() || `LibreOffice exited with code ${code}`))
    })
  })
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export class ConverterPool {
  constructor({
    size = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
    basePort = 2002,
    jobTimeoutMs = 180_000,
    cacheEntries = 40,
    workDir = path.join(os.tmpdir(), 'asaaei-convert'),
    onLog = () => {},
  } = {}) {
    this.size = size
    this.basePort = basePort
    this.jobTimeoutMs = jobTimeoutMs
    this.workDir = workDir
    this.onLog = onLog
    this.engines = []
    this.queue = []
    this.mode = 'starting' // 'uno' | 'cli' | 'starting' | 'unavailable'
    this.version = ''
    this.error = ''
    this.stats = { converted: 0, cacheHits: 0, failures: 0, totalMs: 0 }
    // A tiny LRU keyed by the source bytes: opening the same form twice should
    // be instant the second time.
    this.cache = new Map()
    this.cacheLimit = cacheEntries
  }

  async init() {
    await fs.mkdir(this.workDir, { recursive: true })
    const soffice = await findSoffice()
    this.soffice = soffice
    this.version = await sofficeVersion(soffice).catch(() => '')
    if (!this.version) {
      this.mode = 'unavailable'
      this.error = `LibreOffice was not found. Install it (libreoffice-writer), or set SOFFICE_PATH to the soffice binary.`
      this.onLog(this.error)
      return
    }
    this.onLog(`found ${this.version} at ${soffice}`)

    const python = await findUnoPython(soffice)
    const profileRoot = path.join(this.workDir, 'profiles')
    await fs.mkdir(profileRoot, { recursive: true })

    if (python) {
      this.mode = 'uno'
      this.onLog(`using warm UNO workers via ${python} (pool of ${this.size})`)
      for (let i = 0; i < this.size; i++) {
        this.engines.push(new Engine({
          id: i, port: this.basePort + i, soffice, python, profileRoot,
          jobTimeoutMs: this.jobTimeoutMs, onLog: this.onLog,
        }))
      }
      // Warm every engine now so the first real document does not pay start-up.
      // A failure here is not fatal — fall back to the CLI path.
      try {
        await Promise.all(this.engines.map((e) => e.start()))
      } catch (err) {
        this.onLog(`warm start failed (${err.message}) — falling back to the CLI path`)
        this.engines.forEach((e) => e.stop())
        this.engines = []
        this.mode = 'cli'
      }
    } else {
      this.mode = 'cli'
      this.onLog('python3-uno not found — using the slower per-job CLI path. '
        + 'Install python3-uno (Linux) for warm, sub-second conversions.')
    }

    if (this.mode === 'cli') {
      for (let i = 0; i < this.size; i++) {
        const e = new CliEngine({
          id: i, soffice, profileRoot, jobTimeoutMs: this.jobTimeoutMs, onLog: this.onLog,
        })
        await e.start()
        this.engines.push(e)
      }
    }

    await this.selfTest()
  }

  // Prove the installation can actually produce a PDF before telling the app
  // that exact conversion is on.
  //
  // `soffice --version` answering is not proof: a core-only install
  // (libreoffice-core without libreoffice-writer) starts, reports a version and
  // accepts UNO connections, then fails every document with "type detection
  // failed" because it has no Writer filters at all. Reporting that as a
  // healthy converter is worse than reporting none — the app says "exact
  // conversion" while quietly rasterising every form it is given, which is how
  // a document silently loses its layout.
  async selfTest() {
    if (!this.available) return
    if (process.env.ASAAEI_SKIP_SELFTEST === '1') {
      this.onLog('conversion self-test skipped (ASAAEI_SKIP_SELFTEST=1)')
      return
    }
    const sample = Buffer.from('ASAaei converter self-test.\n', 'utf8')
    try {
      const { bytes } = await this.convert(sample, 'selftest.txt', { quality: 'fast' })
      if (!bytes || bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
        throw new Error('the output was not a PDF')
      }
      // Don't let the self-test occupy a cache slot meant for real forms.
      this.cache.clear()
      this.stats = { converted: 0, cacheHits: 0, failures: 0, totalMs: 0 }
    } catch (err) {
      this.cache.clear()
      this.stats = { converted: 0, cacheHits: 0, failures: 0, totalMs: 0 }
      this.engines.forEach((e) => e.stop())
      this.engines = []
      this.mode = 'unavailable'
      this.error = /type detection failed|could not be loaded/i.test(err.message || '')
        ? 'LibreOffice is installed but has no Writer document filters, so it cannot open '
          + 'Word files. Install the Writer package (Debian/Ubuntu: libreoffice-writer; '
          + 'the full "libreoffice" package includes it).'
        : `LibreOffice could not convert a test document: ${err.message}`
      this.onLog(`conversion self-test FAILED — ${this.error}`)
    }
  }

  get available() { return this.mode === 'uno' || this.mode === 'cli' }

  health() {
    const { converted, cacheHits, failures, totalMs } = this.stats
    return {
      ok: this.available,
      engine: this.version || null,
      mode: this.mode,
      workers: this.engines.length,
      warm: this.mode === 'uno',
      accepts: Object.keys(INPUT_FILTERS),
      quality: Object.keys(QUALITY_PRESETS),
      error: this.error || undefined,
      stats: {
        converted, cacheHits, failures,
        avgMs: converted ? Math.round(totalMs / converted) : 0,
      },
    }
  }

  // Convert `buffer` (a document named `filename`) to PDF bytes.
  async convert(buffer, filename, { quality = 'balanced' } = {}) {
    if (!this.available) throw new Error(this.error || 'the converter is not available')
    const ext = path.extname(filename || '').toLowerCase()
    const filter = INPUT_FILTERS[ext]
    if (!filter) {
      throw new Error(`${ext || 'that file type'} cannot be converted. `
        + `Supported: ${Object.keys(INPUT_FILTERS).join(', ')}`)
    }
    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced

    const key = createHash('sha256')
      .update(buffer).update('\0').update(ext).update('\0').update(quality)
      .digest('hex')
    const hit = this.cache.get(key)
    if (hit) {
      // Refresh LRU position so a form in daily use never falls out.
      this.cache.delete(key)
      this.cache.set(key, hit)
      this.stats.cacheHits++
      return { bytes: hit.bytes, ms: 0, cached: true, pages: hit.pages, missingFonts: hit.missingFonts }
    }

    // Which fonts this document wants that the machine hasn't got. A missing
    // font is the usual reason a converted page doesn't match Word exactly, so
    // it travels back with the result instead of failing silently.
    const missingFonts = ext === '.docx' || ext === '.docm' || ext === '.dotx'
      ? await checkFonts(fontsUsedInDocx(buffer)).catch(() => [])
      : []

    const engine = await this._acquire()
    const stamp = key.slice(0, 12)
    const src = path.join(this.workDir, `in-${stamp}${ext}`)
    const out = path.join(this.workDir, `out-${stamp}.pdf`)
    try {
      await fs.writeFile(src, buffer)
      const res = await engine.convert({
        src, out, filter,
        filterData: { ...COMMON_FILTER_DATA, ...preset },
      })
      const bytes = await fs.readFile(out)
      this.stats.converted++
      this.stats.totalMs += res.ms || 0
      this._cache(key, bytes, res.pages || 0, missingFonts)
      return { bytes, ms: res.ms || 0, cached: false, pages: res.pages || 0, missingFonts }
    } catch (err) {
      this.stats.failures++
      throw err
    } finally {
      await fs.rm(src, { force: true }).catch(() => {})
      await fs.rm(out, { force: true }).catch(() => {})
      this._release(engine)
    }
  }

  _cache(key, bytes, pages, missingFonts) {
    // Skip very large results so the cache can't balloon the server's memory.
    if (bytes.length > 24 * 1024 * 1024) return
    this.cache.set(key, { bytes, pages, missingFonts })
    while (this.cache.size > this.cacheLimit) {
      this.cache.delete(this.cache.keys().next().value)
    }
  }

  // Hand out a free engine, or wait in line for one. Serialising per engine is
  // required — a single LibreOffice instance converts one document at a time.
  _acquire() {
    const free = this.engines.find((e) => !e.busy)
    if (free) { free.busy = true; return Promise.resolve(free) }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  _release(engine) {
    engine.busy = false
    const next = this.queue.shift()
    if (next) { engine.busy = true; next(engine) }
  }

  stop() { this.engines.forEach((e) => e.stop()) }
}

// ---------------------------------------------------------------------------

function sofficeVersion(soffice) {
  return new Promise((resolve, reject) => {
    const child = spawn(soffice, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.on('error', reject)
    const timer = setTimeout(() => { try { child.kill() } catch {}; reject(new Error('timeout')) }, 20_000)
    child.on('exit', () => {
      clearTimeout(timer)
      const line = out.split('\n').find((l) => /LibreOffice/i.test(l))
      line ? resolve(line.trim()) : reject(new Error('no version output'))
    })
  })
}

// LibreOffice wants a file:// URL for -env:UserInstallation, and it must be
// spelled the way the platform expects (three slashes plus a drive letter on
// Windows).
function pathToFileUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, '/')
  return 'file://' + (abs.startsWith('/') ? '' : '/') + encodeURI(abs)
}

// Split a stream into newline-delimited records, holding a partial tail between
// chunks. The worker's replies are one JSON object per line.
function readLines(stream, onLine) {
  let buf = ''
  stream.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onLine(line)
    }
  })
}
