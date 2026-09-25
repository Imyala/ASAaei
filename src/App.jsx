import React, { useCallback, useEffect, useRef, useState } from 'react'
import { startPdfRender, revokePageImages } from './pdfRender.js'
import { bakePdf } from './bake.js'
import { fileToPdfBytes } from './convert.js'
import { loadTemplate, saveTemplate, findTemplateByDocKey, loadBoxEdits, saveBoxEdits, clearBoxEdits } from './store.js'
import { createCellFinder, cellAtPoint } from './pdfBoxes.js'
import { diffBoxEdits, applyBoxEdits, hasBoxEdits, sameBox } from './boxEdits.js'
import { getProfile, setProfile, applyProfile } from './profile.js'
import Settings from './Settings.jsx'
import Mark from './Mark.jsx'
import { TICK_CYCLE, cycleFor, nextStatus, carryValue } from './answers.js'
import { discoverConverter, getConverterSettings, lastConverterStatus } from './converter.js'
import { wasmAvailable, deviceEngineEnabled, isolationProblem, STALL_LIMIT_MS, ENGINE_CACHE } from './wasmConverter.js'

// Build stamp injected by Vite (see vite.config.js). Shown in the UI so the
// running version is identifiable when diagnosing stale caches.
const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'

// ---- boxes the tech can add by hand ---------------------------------------
// What each "add" button puts on the page, and its size (page fractions) when
// the tap is not inside a ruled cell to snap to.
const ADD_KINDS = {
  text: { label: 'Text box', size: { w: 0.2, h: 0.022 }, make: () => ({ type: 'text', options: [], label: 'Text' }) },
  status: { label: 'OK / N/A / Fail', size: { w: 0.07, h: 0.022 }, make: () => ({ type: 'status', options: [], label: 'Result' }) },
  tick: { label: 'Tick ✓ ✗', size: { w: 0.022, h: 0 }, make: () => ({ type: 'status', options: ['✓', '✗'], label: 'Tick', covers: true }) },
  signature: { label: 'Signature', size: { w: 0.26, h: 0.06 }, make: () => ({ type: 'signature', options: [], label: 'Signature' }) },
}
const kindOf = (f) => (f.type === 'status' ? (f.options?.[0] === '✓' ? 'tick' : 'status') : f.type)
// What the "open a document" file pickers accept. Legacy .doc is included
// because the LibreOffice converter reads it; without a converter running the
// open path explains that rather than failing obscurely.
const DOC_ACCEPT = '.pdf,.docx,.doc,application/pdf,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword'

// How the tap boxes on a page answer (see answers.js). Auto is each box as
// the form asks — a printed "☐" ticks, a result cell taps OK / N/A / Fail or
// its column's own wording; the others make every tap box on the page answer
// the one way.
const BOX_MODES = [
  { key: '', menu: 'Auto', title: 'Each box as the form asks: printed boxes tick, result cells tap OK / N/A / Fail' },
  { key: 'type', menu: '123 Type', title: 'Type into every box' },
  { key: 'tick', menu: '✓ ✗ Tick or cross', title: 'Every box taps tick, cross, clear' },
  { key: 'status', menu: 'OK / N/A / Fail', title: 'Every box taps OK, N/A, Fail, clear' },
]
// CSS class for a status value: 'OK'/'Pass' read as good, 'Fail' as bad.
const statusClass = (v) => {
  if (!v) return 'blank'
  const s = String(v)
  if (/^(ok|pass|yes|done|✓)$/i.test(s)) return 'OK'
  if (/^(fail|no|not .+|✗)$/i.test(s)) return 'Fail'
  if (/^\d+$/.test(s)) return 'val' // a grade on a printed scale
  return 'NA'
}

// A tick or a cross dropped anywhere on a page from the toolbar: its size as
// a share of the page's width (about a line of type high on A4).
const MARK_W = 0.032
const MARKS = { '✓': 'Tick', '✗': 'Cross' }
function MarkGlyph({ mark }) {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor"
      strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {mark === '✗' ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4.5 12.5l5 5L20 6.5" />}
    </svg>
  )
}

let idCounter = 1
const nextId = () => `f${idCounter++}`

function nowStamp() {
  const d = new Date()
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

// Reset a saved template's fields into a fresh, empty instance to fill.
const instantiate = (fields) =>
  fields.map((f) => ({ ...f, id: nextId(), value: f.type === 'signature' ? null : '' }))

export default function App() {
  const [screen, setScreen] = useState('home') // 'home' | 'editor' | 'settings' | 'opening' | 'approx'
  // How the document now open was produced: 'exact' (LibreOffice / a real PDF)
  // or 'approximate' (in-browser rasteriser).
  const [fidelity, setFidelity] = useState('')
  const [missingFonts, setMissingFonts] = useState([])
  // What the in-page engine's pre-flight had to leave blank (EMF/WMF
  // drawings it cannot draw) — shown above the document, like missing fonts.
  const [graphicNotes, setGraphicNotes] = useState([])
  // The document currently being opened: { name, stage, detail, progress,
  // cancel, error }. Non-null means the opening screen is what to show.
  const [opening, setOpening] = useState(null)
  // A Word document waiting on the "this will lose its layout" answer:
  // { file, reason, fix }.
  const [approxAsk, setApproxAsk] = useState(null)

  // editor state
  const [pages, setPages] = useState([])
  const [pdfBytes, setPdfBytes] = useState(null)
  const [fileName, setFileName] = useState('document')
  const [fields, setFields] = useState([])
  const [mode, setMode] = useState('fill')
  const [tool, setTool] = useState('select')
  const [selectedId, setSelectedId] = useState(null)
  const [locked, setLocked] = useState(false)
  // Whether boxes this tech added or removed on an earlier visit were put
  // back when this form opened.
  const [editsApplied, setEditsApplied] = useState(false)
  // Dropping ticks and crosses: the mark chosen to tap onto the page ('' when
  // none), and the mark being dragged from the toolbar with where it is.
  const [armedMark, setArmedMark] = useState('')
  const [markDrag, setMarkDrag] = useState(null) // { mark, x, y, moved }
  const [busy, setBusy] = useState('')
  const [docKey, setDocKey] = useState('')
  const [docTitle, setDocTitle] = useState('')
  const [appliedTemplate, setAppliedTemplate] = useState('') // name of an auto-applied layout
  const [selectedPages, setSelectedPages] = useState(new Set()) // page indices to fill
  const [pageOrder, setPageOrder] = useState([]) // original page indices in display order
  const [showPages, setShowPages] = useState(false)
  // How the tap boxes answer (BOX_MODES): on every page, and on any page set
  // its own way (page index -> mode).
  const [boxMode, setBoxMode] = useState('')
  const [pageModes, setPageModes] = useState({})
  const [profile, setProfileState] = useState(getProfile())
  // What the "check for update" link last said: '' | a short message.
  const [updateNote, setUpdateNote] = useState('')
  const [updateBusy, setUpdateBusy] = useState(false)
  // A newer build has taken over in the background and is waiting for the
  // page to load it.
  const [updateReady, setUpdateReady] = useState(false)
  const updateProfile = (patch) => {
    const p = { ...profile, ...patch }
    setProfileState(p); setProfile(p)
  }

  const fileRef = useRef(null)
  const pendingRef = useRef(null) // { action }
  // The document as it was opened — its PDF bytes and what was detected in
  // it — so "Reload file" can put it back exactly, without converting again.
  const openedRef = useRef(null) // { bytes, name, meta }
  const dragRef = useRef(null)
  // The in-flight page render, so opening another document can stop it and
  // reclaim its images rather than leaving them drawing into nothing.
  const renderRef = useRef(null)
  // Lets the opening screen's Cancel actually stop the work in flight.
  const openJobRef = useRef(null)
  // The fields detection found when this document opened, before any saved
  // hand edits — what those edits are measured against.
  const baseFieldsRef = useRef([])
  // Where this document's hand edits are kept: its document number, or its
  // file name when it has none.
  const editKeyRef = useRef('')
  // Reads the ruled cells of a page on demand, to snap an added box.
  const cellFinderRef = useRef(null)

  const selected = fields.find((f) => f.id === selectedId) || null

  // Look for a converter in the background so the first Word file opens
  // without waiting on the probe. This never blocks anything: the app is fully
  // usable while it runs, and a negative answer only means Word files take
  // the in-page engine. Nothing on screen reports the answer — a technician
  // cannot act on it, and Settings › Advanced shows it to whoever can.
  useEffect(() => { discoverConverter() }, [])

  // New builds arrive by themselves. The browser only looks for a new
  // service worker when a page loads, and the one it finds takes over the
  // page already open — which kept running the old build until a second
  // reload, so a fix published in the morning was not on the tablet in the
  // afternoon. Look shortly after start, whenever the app comes back to the
  // screen, and every half hour; when a newer worker takes over, load the new
  // build straight away on the home screen, and in the editor offer it
  // without touching the document being filled.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined
    const hadController = !!navigator.serviceWorker.controller
    const onTakeover = () => { if (hadController) setUpdateReady(true) }
    navigator.serviceWorker.addEventListener('controllerchange', onTakeover)
    const look = () => navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => {})
    const first = setTimeout(look, 5000)
    const every = setInterval(look, 30 * 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') look() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onTakeover)
      clearTimeout(first); clearInterval(every)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  useEffect(() => {
    if (updateReady && (screen === 'home' || screen === 'settings')) location.reload()
  }, [updateReady, screen])

  // ---- rendering a document into the editor -------------------------------
  // Page geometry comes back at once, so the document is on screen and fillable
  // immediately; the page images arrive behind it, nearest the page being read
  // first. Waiting for all of them before showing anything is what made opening
  // a long procedure feel like the app had stalled.
  const showBytesInEditor = useCallback(async (bytes, name, opts) => {
    const render = await startPdfRender(bytes, {
      onPage: (index, patch) => setPages((prev) => {
        // A newer document may have replaced this one mid-render.
        if (renderRef.current !== render || !prev[index]) {
          if (patch.src) URL.revokeObjectURL(patch.src)
          return prev
        }
        const next = [...prev]
        next[index] = { ...next[index], ...patch }
        return next
      }),
    })
    // Stop the previous document's render and free its images.
    renderRef.current?.cancel()
    setPages((old) => { revokePageImages(old); return render.sizes })
    renderRef.current = render

    const imgs = render.sizes
    setPdfBytes(bytes)
    setFileName(name.replace(/\.(pdf|docx?)$/i, '') || 'document')
    // How this document was produced travels with it. Setting it here, rather
    // than at the call site, means a blank page or a reopened offline copy
    // clears the banner instead of inheriting the last document's.
    setFidelity(opts.fidelity || '')
    setMissingFonts(opts.missingFonts || [])
    setGraphicNotes(opts.graphicNotes || [])
    if (opts.fields !== undefined) setFields(opts.fields)
    if (opts.mode) setMode(opts.mode)
    if (opts.resetLock) setLocked(false)
    // Pages start in natural order, ALL selected by default (a fresh document
    // is ready to fill end-to-end). A saved template may still pin a subset.
    const total = imgs.length
    const allIdx = imgs.map((_, i) => i)
    setPageOrder(allIdx)
    const sel = (opts.pages && opts.pages.length)
      ? opts.pages.filter((p) => p >= 0 && p < total)
      : allIdx
    setSelectedPages(new Set(sel.length ? sel : allIdx))
    setShowPages(false)
    setBoxMode('')
    setPageModes({})
    setSelectedId(null)
    setTool('text')
    setScreen('editor')
    return total
  }, [])

  // Central open path. LIVE DETECTION ALWAYS WINS: the fields are read fresh
  // from this document every time, so a re-issued/edited form just works with no
  // setup. A saved layout is only a silent fallback for a form the detector
  // can't read — it never overrides good detection (which would go stale when
  // the document changes). Used by the "Fill out a document" flow.
  const openDocument = useCallback(async (bytes, name, meta = {}) => {
    openedRef.current = { bytes, name, meta }
    const {
      autoFields = [], docKey: dk = '', docTitle: dt = '',
      fidelity = '', missingFonts = [], graphicNotes = [],
    } = meta
    setDocKey(dk); setDocTitle(dt)
    let fields = autoFields.map((f) => ({ ...f, id: nextId() }))
    let pages = null, applied = ''
    if (fields.length === 0) {
      const match = await findTemplateByDocKey(dk)
      if (match) {
        const tpl = await loadTemplate(match.id)
        fields = instantiate(tpl.fields)
        pages = tpl.pages && tpl.pages.length ? tpl.pages : null
        applied = match.name
      }
    }
    baseFieldsRef.current = fields
    editKeyRef.current = dk || `file:${name.toLowerCase()}`
    cellFinderRef.current?.destroy()
    cellFinderRef.current = createCellFinder(bytes)
    // Fill the tech's own recurring fields (name, SAP ID, date) up front.
    fields = applyProfile(fields, getProfile())
    setAppliedTemplate(applied)
    const pageCount = await showBytesInEditor(bytes, name, {
      fields, mode: 'fill', resetLock: true, pages,
      fidelity, missingFonts, graphicNotes,
    })
    // Boxes the tech added or removed on this form before go back on, over
    // what detection found this time.
    const edits = await loadBoxEdits(editKeyRef.current).catch(() => null)
    const withEdits = applyBoxEdits(baseFieldsRef.current, edits, pageCount, nextId)
    if (withEdits.applied) setFields(applyProfile(withEdits.fields, getProfile()))
    setEditsApplied(withEdits.applied)
  }, [showBytesInEditor])

  // "Reload file": the document as it was when it opened — every box empty
  // again except the tech's own details, every signature gone. It works from
  // the PDF already in hand, so a Word document is not converted a second
  // time. It asks first: on a tablet this is one tap from a page of work.
  const reloadDocument = async () => {
    const opened = openedRef.current
    if (!opened) return
    if (!window.confirm('Reload this document? Everything you have typed, ticked and signed on it will be cleared.')) return
    setBusy('Reloading the document…')
    try {
      await openDocument(opened.bytes, opened.name, opened.meta)
    } finally {
      setBusy('')
    }
  }

  // ---- file chosen (new design / reload) ----------------------------------
  const onFileChosen = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    // A Word document with no converter to hand would be rebuilt from scratch
    // and photographed: the text survives, the layout does not — column widths,
    // ruled cells, headers and page breaks all move. A controlled document that
    // has moved is not a lower-quality copy of itself, it is a different
    // document, and no amount of warning text makes one safe to sign. So the
    // app stops here and offers the two routes that keep the layout exactly.
    // Producing an approximate copy stays possible, but only for someone who
    // has gone into Settings and asked for it.
    // The engine inside the website counts as exact conversion, so this screen
    // only appears when that engine is switched off or the page cannot run it.
    if (/\.docx?$/i.test(file.name) && getConverterSettings().mode !== 'browser'
        && !wasmAvailable()) {
      const found = await discoverConverter()
      if (!found.ok) {
        setApproxAsk({ file, reason: found.reason, fix: found.fix })
        setScreen('approx')
        return
      }
    }
    beginOpen(file)
  }

  const beginOpen = async (file) => {
    const isWord = /\.docx?$/i.test(file.name)

    // Leave the home screen NOW. Converting a long Word document takes a few
    // seconds, and this used to happen with the home screen still on display
    // and one line of small text at the bottom — so it looked as though the tap
    // had half-worked. An opening screen makes the wait legible instead.
    const job = new AbortController()
    openJobRef.current = job
    setOpening({
      name: file.name,
      stage: isWord ? 'Converting the Word document…' : 'Opening the document…',
      // Which engine line to show is settled per stage below — announcing
      // "approximate" here, before knowing the route, was simply wrong: the
      // LibreOffice engine in the page converts exactly.
      detail: isWord && lastConverterStatus()?.ok
        ? `Using ${lastConverterStatus().info?.engine || 'LibreOffice'} — the layout will match Word exactly.`
        : isWord && wasmAvailable()
          ? 'Looking for a converter — without one, LibreOffice runs inside this page and the layout still matches Word exactly.'
          : isWord
            ? 'Converting in this browser. This is slower and the layout is approximate.'
            : '',
      progress: 0,
      // Cancel leaves NOW — the screen goes home on the click, not when the
      // conversion pipeline gets around to noticing the abort. The abort
      // signal tears the in-page engine down (its worker is terminated), and
      // every late completion below checks the signal before touching state.
      cancel: () => { job.abort(); setOpening(null); setScreen('home') },
    })
    setScreen('opening')
    setBusy('')
    try {
      const {
        bytes, autoFields = [], docKey: dk = '', docTitle: dt = '',
        fidelity: fid = '', missingFonts: fonts = [], graphicNotes: gnotes = [],
      } = await fileToPdfBytes(file, {
        signal: job.signal,
        onProgress: (done, total, meta) => setOpening((o) => o && ({
          ...o,
          // The service route has no page-by-page progress to report — it
          // returns the whole PDF at once, and quickly — so don't invent one.
          // The in-page engine reports real fractions (download, compile,
          // conversion stages); show those on the bar.
          stage: meta?.stage === 'service'
            ? 'Converting with LibreOffice…'
            : meta?.stage === 'wasm'
              ? (meta.message || 'Converting with LibreOffice in this browser…')
              : `Converting in this browser — page ${Math.min(done + 1, total)} of ${total}…`,
          detail: meta?.stage === 'wasm'
            ? 'LibreOffice is running inside this page — the layout will match Word exactly. '
              + 'A long procedure can take several minutes; the converter service does it in seconds.'
            : o.detail,
          // The wasm route shows a live elapsed clock (see ConvertTimer): the
          // moment that route starts, remember when, and keep it running.
          engineStartedAt: meta?.stage === 'wasm'
            ? (o.engineStartedAt || (Date.now() - (meta.elapsedMs || 0)))
            : o.engineStartedAt,
          // When the engine last moved to a NEW step — the stall advisory
          // rests on this, not on elapsed time: slow is fine, stuck is not.
          stageChangedAt: meta?.stage === 'wasm'
            ? (meta.message && meta.message !== o.stage ? Date.now() : (o.stageChangedAt || Date.now()))
            : o.stageChangedAt,
          progress: meta?.stage === 'service'
            ? 0
            : meta?.stage === 'wasm'
              ? (Number.isFinite(meta.fraction) ? meta.fraction : 0)
              : !total ? 0 : (done / total),
        })),
      })
      if (job.signal.aborted) return
      setOpening((o) => o && { ...o, stage: 'Laying out the pages…', progress: 0 })
      const provenance = { fidelity: fid, missingFonts: fonts, graphicNotes: gnotes }
      // Recognise the form and auto-apply a saved layout if we have one;
      // otherwise fall back to auto-detected fields.
      await openDocument(bytes, file.name, { autoFields, docKey: dk, docTitle: dt, ...provenance })
    } catch (err) {
      if (job.signal.aborted || err?.name === 'AbortError') {
        // The user cancelled — that is not a failure, so no alarm about it.
        setScreen('home')
        return
      }
      // Report the failure on the opening screen rather than in an alert the
      // user has to dismiss before they can see where they are.
      setOpening((o) => o && {
        ...o,
        error: err?.message || 'That file could not be opened.',
        stage: '',
      })
      return
    } finally {
      setBusy('')
      if (openJobRef.current === job) openJobRef.current = null
    }
    setOpening(null)
  }

  const pickFile = (action) => {
    pendingRef.current = { action }
    fileRef.current?.click()
  }

  // ---- adding / removing boxes by hand ("Edit boxes") ----------------------
  // Tap the page to add a box of the chosen kind. It snaps to the ruled cell
  // under the tap, so it fits its square; off the grid it lands centred on the
  // tap. Tap a box to select it, drag it to move it, drag its corner to size
  // it, and × to delete it.
  const onPageClick = async (e, pageIndex) => {
    if (mode !== 'design') {
      // A tick or cross chosen in the toolbar goes where the page is tapped;
      // otherwise a tap on the page lets go of a selected mark.
      if (armedMark) placeMark(pageIndex, e.currentTarget, e.clientX, e.clientY, armedMark)
      else setSelectedId(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    const kind = ADD_KINDS[tool] || ADD_KINDS.text
    let box = null
    const found = await cellFinderRef.current?.cellsOn(pageIndex).catch(() => null)
    if (found && found.pw) {
      const c = cellAtPoint(found.cells, fx * found.pw, fy * found.ph, found.pw, found.ph)
      if (c) {
        const pad = 1.5
        box = { xPct: (c.x + pad) / found.pw, yPct: (c.y + pad) / found.ph, wPct: (c.w - pad * 2) / found.pw, hPct: (c.h - pad * 2) / found.ph }
      }
    }
    if (!box) {
      const w = kind.size.w
      const h = kind.size.h || w * (rect.width / rect.height) // a tick box is square
      box = { xPct: clamp(fx - w / 2, 0, 1 - w), yPct: clamp(fy - h / 2, 0, 1 - h), wPct: w, hPct: h }
    }
    // A box already there: select it rather than stack a second on top.
    const hit = fields.find((f) => sameBox({ ...box, page: pageIndex }, f))
    if (hit) { setSelectedId(hit.id); return }
    const field = { id: nextId(), page: pageIndex, ...box, ...kind.make(), value: tool === 'signature' ? null : '' }
    setFields((fs) => [...fs, field])
    setSelectedId(field.id)
  }
  // Put a tick or a cross on a page, centred where it was dropped or tapped.
  const placeMark = (pageIndex, pageEl, clientX, clientY, mark) => {
    const rect = pageEl.getBoundingClientRect()
    const w = MARK_W
    const h = w * (rect.width / rect.height)
    const fx = (clientX - rect.left) / rect.width
    const fy = (clientY - rect.top) / rect.height
    const field = {
      id: nextId(), type: 'mark', page: pageIndex, options: [], value: mark, label: MARKS[mark] || 'Mark',
      xPct: clamp(fx - w / 2, 0, 1 - w), yPct: clamp(fy - h / 2, 0, 1 - h), wPct: w, hPct: h,
    }
    setFields((fs) => [...fs, field])
    setSelectedId(field.id)
  }
  const placeMarkRef = useRef(placeMark)
  placeMarkRef.current = placeMark
  // Drag a ✓ or ✗ from the toolbar and let go over a page. A tap without a
  // drag chooses it instead, and each tap on the page then places one — the
  // easier way on a tablet — until the chip is tapped again.
  const markDragRef = useRef(null) // { mark, sx, sy, moved }
  const onMarkChipDown = (e, mark) => {
    e.preventDefault()
    markDragRef.current = { mark, sx: e.clientX, sy: e.clientY, moved: false }
  }
  useEffect(() => {
    const move = (e) => {
      const d = markDragRef.current
      if (!d) return
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6) d.moved = true
      if (d.moved) setMarkDrag({ mark: d.mark, x: e.clientX, y: e.clientY })
    }
    const up = (e) => {
      const d = markDragRef.current
      markDragRef.current = null
      setMarkDrag(null)
      if (!d) return
      if (!d.moved) { setArmedMark((m) => (m === d.mark ? '' : d.mark)); return }
      const pageEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-page]')
      if (pageEl) placeMarkRef.current(Number(pageEl.dataset.page), pageEl, e.clientX, e.clientY, d.mark)
    }
    const cancel = () => { markDragRef.current = null; setMarkDrag(null) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [])
  useEffect(() => {
    if (!armedMark) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setArmedMark('') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [armedMark])
  const updateField = (id, patch) =>
    setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  const deleteField = (id) => {
    setFields((fs) => fs.filter((f) => f.id !== id))
    if (selectedId === id) setSelectedId(null)
  }
  // Change a box between a text box, an OK / N/A / Fail cell and a tick box.
  const retypeField = (f, kind) => {
    const made = ADD_KINDS[kind].make()
    const generic = !f.label || Object.values(ADD_KINDS).some((k) => k.make().label === f.label)
    updateField(f.id, { ...made, covers: !!made.covers, label: generic ? made.label : f.label, value: '' })
  }

  // The hand edits so far, kept for this form: the next time it opens they
  // go back on over fresh detection.
  const saveEditsNow = (fs = fields) => {
    const key = editKeyRef.current
    if (!key || !pages.length) return
    const edits = diffBoxEdits(baseFieldsRef.current, fs, pages.length)
    ;(hasBoxEdits(edits) ? saveBoxEdits(key, edits) : clearBoxEdits(key)).catch(() => {})
  }
  useEffect(() => {
    if (mode !== 'design') return
    const t = setTimeout(() => saveEditsNow(), 600)
    return () => clearTimeout(t)
  }, [fields, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const startEditing = () => { setMode('design'); setTool('text'); setSelectedId(null) }
  const stopEditing = () => { saveEditsNow(); setMode('fill'); setSelectedId(null) }
  // Back to exactly what detection found: every box added by hand goes, every
  // box removed comes back. Values typed into boxes that stay are kept.
  const resetBoxes = () => {
    if (!window.confirm('Put the boxes back the way they were detected? Boxes you added are removed and boxes you deleted come back.')) return
    const values = new Map(fields.map((f) => [f.id, f.value]))
    const restored = baseFieldsRef.current.map((f) => (values.has(f.id) ? { ...f, value: values.get(f.id) } : f))
    const marks = fields.filter((f) => f.type === 'mark')
    setFields([...applyProfile(restored, getProfile()), ...marks])
    clearBoxEdits(editKeyRef.current).catch(() => {})
    setEditsApplied(false)
    setSelectedId(null)
  }
  // Delete / Backspace removes the selected box while editing (keyboards).
  useEffect(() => {
    if (!selectedId) return
    if (mode !== 'design' && fields.find((f) => f.id === selectedId)?.type !== 'mark') return
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (/^(input|textarea|select)$/i.test(e.target?.tagName || '')) return
      e.preventDefault()
      deleteField(selectedId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, selectedId, fields]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drag to move, or drag the corner handle to size (pointer events, so it
  // works with touch). The grab point stays under the finger.
  const onFieldPointerDown = (e, field, pageEl, how = 'move') => {
    // Boxes move while editing; a dropped tick or cross moves any time.
    if ((mode !== 'design' && field.type !== 'mark') || !pageEl) return
    e.stopPropagation()
    setSelectedId(field.id)
    const rect = pageEl.getBoundingClientRect()
    const px = (e.clientX - rect.left) / rect.width
    const py = (e.clientY - rect.top) / rect.height
    dragRef.current = { id: field.id, pageEl, how, dx: px - field.xPct, dy: py - field.yPct }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current
      if (!d) return
      const rect = d.pageEl.getBoundingClientRect()
      const px = (e.clientX - rect.left) / rect.width
      const py = (e.clientY - rect.top) / rect.height
      setFields((fs) => fs.map((f) => {
        if (f.id !== d.id) return f
        if (d.how === 'resize') {
          return { ...f, wPct: clamp(px - f.xPct, 0.01, 1 - f.xPct), hPct: clamp(py - f.yPct, 0.007, 1 - f.yPct) }
        }
        return { ...f, xPct: clamp(px - d.dx, 0, 1 - f.wPct), yPct: clamp(py - d.dy, 0, 1 - f.hPct) }
      }))
    }
    const up = () => (dragRef.current = null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [])

  // ---- fill actions -------------------------------------------------------
  const signField = (field) => {
    const name = window.prompt('Type the signer’s full name:')
    if (!name) return
    updateField(field.id, { value: { name: name.trim(), timestamp: nowStamp() } })
  }
  const download = async () => {
    if (!pdfBytes) return
    const order = orderedSelection()
    if (!order.length) { alert('Select at least one page to download.'); return }
    // Pass the page order only when it changes what comes out (a subset or a
    // reorder); otherwise bake the whole document untouched.
    const isNatural = order.length === pages.length && order.every((p, i) => p === i)
    setBusy('Building PDF…')
    try {
      const out = await bakePdf(pdfBytes, fields, isNatural ? null : order)
      const blob = new Blob([out], { type: 'application/pdf' })
      const suggestedName = `${fileName}${locked ? '-signed' : ''}.pdf`
      // Use the File System Access API when available so the user can choose
      // both the file name and the save location.
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName,
            types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          return
        } catch (err) {
          if (err.name === 'AbortError') return // user canceled the dialog
          // Fall through to the legacy download path on any other error.
        }
      }
      // Fallback: trigger a browser download (no location prompt in most browsers).
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = suggestedName; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { alert('Could not build the PDF.\n' + e.message) }
    finally { setBusy('') }
  }

  // Drop the service worker and its caches, then reload. The app is a PWA, so a
  // browser that already has it can keep serving the build it cached — which is
  // indistinguishable, from the user's side, from a fix that was never made.
  // "Check for update": ask the server which build it is serving (version.json
  // is written at build time and never precached, so the answer is always the
  // deployed one). Same build → say so and stop. A newer build → ask the
  // service worker registration to update: the browser fetches the new sw.js,
  // the new worker precaches the new build, takes over the page (skipWaiting
  // + clientsClaim in sw.js) and the page reloads onto it — the worker serves
  // its own copy of the page, so this works even while the GitHub Pages CDN
  // is still handing out the previous index.html. Nothing is wiped: the old
  // worker simply retires, and the LibreOffice engine cache (a 78 MB download
  // that does not change between builds) is never touched. If the new worker
  // is not there yet (the CDN still serving the old sw.js, or its files not
  // all published), say so and change nothing — the working app stays up.
  // Without a worker at all (dev server, an unsupported browser) the page is
  // simply loaded again at a fresh URL.
  const checkForUpdate = async () => {
    setUpdateBusy(true)
    setUpdateNote('Checking…')
    let latest
    try {
      const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      latest = String((await res.json()).build || '')
    } catch {
      setUpdateNote(navigator.onLine
        ? 'Could not reach the server — try again in a moment.'
        : 'No connection — try again when online.')
      setUpdateBusy(false)
      return
    }
    if (!latest || latest === BUILD_ID) {
      setUpdateNote('You have the latest version.')
      setUpdateBusy(false)
      return
    }
    setUpdateNote(`Updating to build ${latest}…`)
    const stillPublishing = () => {
      setUpdateNote(`Build ${latest} is still being published — try again in a few minutes.`)
      setUpdateBusy(false)
    }
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => null) : null
    if (!reg) {
      const target = new URL(location.href)
      target.searchParams.set('v', latest)
      try { sessionStorage.clear() } catch { /* private mode */ }
      location.replace(target.href)
      return
    }
    // The new worker announces itself by taking control of this page.
    const claimed = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true })
      setTimeout(() => resolve(false), 90000)
    })
    try { await reg.update() } catch { stillPublishing(); return }
    // No installing worker within a few seconds means the browser found sw.js
    // unchanged: the deploy has not reached the CDN yet.
    let seen = !!(reg.installing || reg.waiting)
    for (let i = 0; i < 20 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 250))
      seen = !!(reg.installing || reg.waiting)
    }
    if (!seen) { stillPublishing(); return }
    setUpdateNote(`Fetching build ${latest}…`)
    if (!(await claimed)) { stillPublishing(); return }
    try { sessionStorage.clear() } catch { /* private mode */ }
    location.reload()
  }

  const goHome = () => {
    // Stop drawing pages nobody is looking at any more, and hand back the
    // memory their images hold.
    renderRef.current?.cancel()
    renderRef.current = null
    if (mode === 'design') saveEditsNow()
    setMode('fill')
    cellFinderRef.current?.destroy()
    cellFinderRef.current = null
    setPages((old) => { revokePageImages(old); return [] })
    setScreen('home'); setFields([]); setPageOrder([])
    setAppliedTemplate(''); setDocKey(''); setDocTitle(''); setShowPages(false)
  }

  // Render whichever page is on screen next. Without this, jumping to page 30
  // of a long form would mean waiting for pages 1-29 to be drawn first.
  const onStageScroll = (e) => {
    const el = e.currentTarget
    const order = orderedSelection()
    if (!order.length || !renderRef.current) return
    const frac = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)
    const pos = Math.round(frac * (order.length - 1))
    renderRef.current.prioritise(order[Math.min(Math.max(pos, 0), order.length - 1)])
  }

  const togglePage = (i) => setSelectedPages((prev) => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })
  // Selected pages in display order — the exact set/order to export.
  const orderedSelection = () => pageOrder.filter((i) => selectedPages.has(i))

  // Drag a page chip to reorder. Pointer-based so it works on touch (iPad) too;
  // we hit-test with elementFromPoint (no pointer capture) so entering another
  // chip mid-drag moves the dragged page to that slot.
  const dragPos = useRef(null)
  useEffect(() => {
    const move = (e) => {
      if (dragPos.current == null) return
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-pagepos]')
      if (!el) return
      const over = Number(el.dataset.pagepos)
      if (Number.isNaN(over) || over === dragPos.current) return
      setPageOrder((ord) => {
        const next = [...ord]
        const [moved] = next.splice(dragPos.current, 1)
        next.splice(over, 0, moved)
        dragPos.current = over
        return next
      })
    }
    const up = () => (dragPos.current = null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [])
  // Whether the document has tap boxes at all — the toolbar's "Boxes" switch
  // is only shown when it does.
  const hasTapBoxes = fields.some((f) => f.type === 'status')
  const modeOfPage = (i) => pageModes[i] ?? boxMode
  // Answers already given follow a switch between ticks and OK / N/A / Fail;
  // typing keeps each one as it is.
  const carryAnswers = (onPage, to) => {
    if (to === 'type') return
    setFields((fs) => fs.map((f) => {
      if (f.type !== 'status' || !onPage(f.page)) return f
      const value = carryValue(f.value, cycleFor(f, to))
      return value === f.value ? f : { ...f, value }
    }))
  }
  // One switch for the whole document: every tap box on every page answers
  // the chosen way. A page's own switch then overrides it for that page.
  const switchAllBoxes = (to) => {
    setBoxMode(to)
    setPageModes({})
    carryAnswers(() => true, to)
  }
  const switchPageBoxes = (i, to) => {
    setPageModes((prev) => {
      const next = { ...prev }
      if (to === boxMode) delete next[i]
      else next[i] = to
      return next
    })
    carryAnswers((p) => p === i, to)
  }
  const pagesWithFields = () => new Set(fields.map((f) => f.page))

  // ================= OPENING A DOCUMENT =================
  // Shown from the moment a file is chosen until the document is on screen.
  // A long conversion used to happen behind the home screen, which read as the
  // app having ignored the tap.
  if (screen === 'opening' && opening) {
    return (
      <div className="home openingscreen">
        <header className="homehead">
          <h1>ASAaei</h1>
        </header>
        <section className="homecard openingcard">
          {opening.error ? (
            <>
              <h2 className="openingtitle error">Could not open this document</h2>
              <p className="openingname">{opening.name}</p>
              <p className="openingerror">{opening.error}</p>
              <div className="openingactions">
                <button className="big primary" onClick={() => { setOpening(null); setScreen('home') }}>
                  Back to home
                </button>
                <button className="big" onClick={() => { setOpening(null); setScreen('home'); setTimeout(() => setScreen('settings'), 0) }}>
                  Open settings
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="openingtitle">Opening your document</h2>
              <p className="openingname">{opening.name}</p>
              <div className="openingbar">
                {/* A known page count gives a real bar; otherwise an indeterminate
                    one, because a made-up percentage is worse than none. */}
                <div className={'openingbar-fill' + (opening.progress ? '' : ' indeterminate')}
                  style={opening.progress ? { width: `${Math.round(opening.progress * 100)}%` } : undefined} />
              </div>
              {opening.engineStartedAt && (
                <ConvertTimer startedAt={opening.engineStartedAt} pct={opening.progress}
                  stageChangedAt={opening.stageChangedAt} />
              )}
              <p className="openingstage">{opening.stage}</p>
              {opening.detail && <p className="openingdetail">{opening.detail}</p>}
              <button className="openingcancel" onClick={() => opening.cancel?.()}>Cancel</button>
            </>
          )}
        </section>
      </div>
    )
  }

  // ================= WORD FILE, NO EXACT CONVERSION =================
  // The one screen in the app that refuses. Both routes out of it are quick,
  // and either one keeps the document identical to the original — which is the
  // only acceptable outcome for a document that may be held as a record.
  if (screen === 'approx' && approxAsk) {
    return (
      <div className="home openingscreen">
        <input ref={fileRef} type="file" accept={DOC_ACCEPT} hidden onChange={onFileChosen} />
        <header className="homehead">
          <h1>ASAaei</h1>
        </header>
        <section className="homecard openingcard approxcard">
          <h2 className="openingtitle warn">This Word file needs exact conversion</h2>
          <p className="openingname">{approxAsk.file.name}</p>
          <p className="approxbody">
            Exact conversion is not available here, and the app will not rebuild a Word document
            at approximate geometry: the words would survive, but column widths, ruled cells,
            headers and page breaks would all move. A controlled document that has moved is not
            a rougher copy of itself — it is a different document. Two ways to open it properly:
          </p>

          <div className="approxroute">
            <b>1 · Save it as a PDF from Word — nothing to install</b>
            <p>
              Open the file in Word, choose <b>File → Save as</b> and pick <b>PDF</b>. Open that
              PDF here. It is Word's own rendering, so the layout is exact to the millimetre, the
              text stays selectable, and the fill boxes land in the document's real ruled cells.
            </p>
            <button className="big primary" onClick={() => { setApproxAsk(null); pickFile('new') }}>
              Choose the PDF instead
            </button>
          </div>

          <div className="approxroute muted">
            <b>2 · Set up the converter, and every Word file opens exactly</b>
            <p>{approxAsk.reason}{approxAsk.fix ? ` ${approxAsk.fix}` : ''}</p>
            <button onClick={() => { setApproxAsk(null); setScreen('settings') }}>
              Open conversion settings
            </button>
          </div>

          {deviceEngineEnabled() && isolationProblem() && (
            <div className="approxroute muted">
              <b>3 · LibreOffice inside the website</b>
              <p>{isolationProblem()}</p>
              {!window.crossOriginIsolated && window.isSecureContext && (
                <button onClick={() => {
                  // The page arranges its own isolation on reload once the
                  // service worker is in place; a stale "already reloaded"
                  // note from earlier in this tab must not veto that.
                  try { sessionStorage.removeItem('asaaei:coi-reload') } catch { /* private mode */ }
                  location.reload()
                }}>
                  Reload the page
                </button>
              )}
            </div>
          )}

          <div className="openingactions approxactions">
            <button onClick={() => { setApproxAsk(null); setScreen('home') }}>Cancel</button>
          </div>
        </section>
      </div>
    )
  }

  // ================= SETTINGS =================
  if (screen === 'settings') {
    return (
      <Settings
        profile={profile}
        onProfile={updateProfile}
        onExit={() => {
          // Re-probe on the way out: the point of visiting Settings is usually
          // to start or point at a converter, and the next Word file should
          // find it without a stale "not there" answer.
          discoverConverter({ force: true })
          setScreen('home')
        }}
      />
    )
  }

  // ================= HOME SCREEN =================
  // Deliberately quiet: one thing to do, said plainly, with everything else
  // (status, provenance) demoted to the footer where it can be glanced at
  // rather than read. A technician opening this on a tablet in a plant room
  // should see the one button they came for, not a control panel. Settings
  // exists for their name and SAP ID; everything else in it is for setup.
  if (screen === 'home') {
    return (
      <div className="landing">
        <input ref={fileRef} type="file" accept={DOC_ACCEPT} hidden onChange={onFileChosen} />

        <div className="landing-inner">
          <header className="landing-head">
            <Mark />
            <div className="landing-title">
              <h1>ASAaei</h1>
              <p className="landing-sub">Fill, sign and lock documents — on iPad, tablet or desktop.</p>
            </div>
            <button className="ghostbtn" onClick={() => setScreen('settings')}>Settings</button>
          </header>

          {/* The one thing to do, made unmissable: a big illustrated card with
              one button sized for a gloved thumb. */}
          <section className="hero">
            <div className="hero-art" aria-hidden="true">
              <svg viewBox="0 0 200 240" width="200" height="240">
                <rect x="20" y="10" width="160" height="220" rx="12" fill="#fff" />
                <rect x="38" y="30" width="70" height="8" rx="4" fill="#2a3d73" />
                <rect x="38" y="46" width="110" height="5" rx="2.5" fill="#c9d3e6" />
                <rect x="38" y="70" width="74" height="6" rx="3" fill="#c9d3e6" />
                <rect x="134" y="64" width="24" height="18" rx="4" fill="#eaf7ee" stroke="#46a86e" strokeWidth="1.5" />
                <path d="M139.5 73 l4 4 7-8" fill="none" stroke="#2f9e57" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                <rect x="38" y="98" width="60" height="6" rx="3" fill="#c9d3e6" />
                <rect x="134" y="92" width="24" height="18" rx="4" fill="#eaf7ee" stroke="#46a86e" strokeWidth="1.5" />
                <path d="M139.5 101 l4 4 7-8" fill="none" stroke="#2f9e57" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                <rect x="38" y="126" width="80" height="6" rx="3" fill="#c9d3e6" />
                <rect x="134" y="120" width="24" height="18" rx="4" fill="#fff" stroke="#c9d3e6" strokeWidth="1.5" />
                <path d="M42 170 c8-20 14-12 20-3 s10 8 18-6 s12 4 18-4 s10 10 24-12"
                  fill="none" stroke="#2a3d73" strokeWidth="2.6" strokeLinecap="round" />
                <rect x="38" y="178" width="120" height="1.5" fill="#d3d9e6" />
                <rect x="38" y="188" width="46" height="5" rx="2.5" fill="#c9d3e6" />
                <circle cx="158" cy="206" r="22" fill="#46a86e" stroke="#fff" strokeWidth="4" />
                <path d="M147 206.5 l7.5 7.5 15-15" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="hero-body">
              <span className="hero-kicker">Start here</span>
              <h2>Fill out a document</h2>
              <p className="hero-lead">
                Open a PDF or Word form. The boxes are found for you — type, tick, sign,
                then save the finished PDF.
              </p>
              <button className="hero-cta" onClick={() => pickFile('new')}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <path d="M12 11v6M9 14l3-3 3 3" />
                </svg>
                Choose a file
              </button>
              <p className="hero-who">
                {profile.name
                  ? <>
                      <span className="avatar" aria-hidden="true">{profile.name.trim().charAt(0).toUpperCase()}</span>
                      <span>Signing as <b>{profile.name}</b>{profile.sapId ? <> · {profile.sapId}</> : null} — your
                        details go into every form as it opens.</span>
                    </>
                  : <>
                      <span className="avatar" aria-hidden="true">?</span>
                      <span>Add your name and SAP ID in{' '}
                        <button className="inlinelink" onClick={() => setScreen('settings')}>Settings</button>{' '}
                        and every form will open already filled in.</span>
                    </>}
              </p>
            </div>
          </section>

          {/* How it goes, in three glances. Nothing here is a control. */}
          <ol className="steps">
            <li>
              <span className="step-n">1</span>
              <span className="step-t"><b>Open</b>a PDF or Word form from this device</span>
            </li>
            <li>
              <span className="step-n">2</span>
              <span className="step-t"><b>Fill &amp; sign</b>tap OK / Fail / N/A, type, sign with a finger</span>
            </li>
            <li>
              <span className="step-n">3</span>
              <span className="step-t"><b>Save</b>a locked PDF, straight back to this device</span>
            </li>
          </ol>

          {busy && <div className="landing-busy">{busy}</div>}

          <footer className="landing-foot">
            <p>Documents are opened from this device and saved back to it. Nothing is uploaded.</p>
            <p className="build">
              Build {BUILD_ID}
              <button className="inlinelink" onClick={checkForUpdate} disabled={updateBusy}>check for update</button>
              {updateNote && <span className="updatenote">{updateNote}</span>}
            </p>
          </footer>
        </div>
      </div>
    )
  }

  // ================= EDITOR =================
  return (
    <div className="app">
      <input ref={fileRef} type="file" accept={DOC_ACCEPT} hidden onChange={onFileChosen} />
      <header className="toolbar">
        <div className="group">
          <button className="ghostbtn" onClick={goHome}>← Home</button>
          <span className="toolbar-doc">
            <strong className="brand">ASAaei</strong>
            <span className="file" title={fileName}>{fileName}</span>
          </span>
          {appliedTemplate && <span className="applied-chip" title="Saved layout applied automatically">✓ {appliedTemplate}</span>}
        </div>

        <div className="group right">
          {mode !== 'design' && (
            <div className="markchips" role="group" aria-label="Drop a tick or a cross anywhere">
              <span className="markchips-label">Drag onto page</span>
              {Object.entries(MARKS).map(([mark, name]) => (
                <button key={mark} type="button" className={'markchip ' + (mark === '✗' ? 'cross' : 'tick') + (armedMark === mark ? ' on' : '')}
                  aria-pressed={armedMark === mark} aria-label={`${name}: drag onto the page, or tap then tap the page`}
                  title={`Drag a ${name.toLowerCase()} onto the page — or tap here, then tap the page`}
                  onPointerDown={(e) => onMarkChipDown(e, mark)}>
                  <MarkGlyph mark={mark} />
                </button>
              ))}
            </div>
          )}
          <button className={'editboxes' + (mode === 'design' ? ' on' : '')}
            onClick={mode === 'design' ? stopEditing : startEditing} aria-pressed={mode === 'design'}
            title={mode === 'design' ? 'Finish adding and removing boxes' : 'Add boxes, move them, or remove them'}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="12" height="12" rx="2" /><path d="M18 15v6M15 18h6" />
            </svg>
            {mode === 'design' ? 'Done editing' : 'Edit boxes'}
          </button>
          {hasTapBoxes && mode !== 'design' && (
            <div className="boxmode" role="group" aria-label="How the boxes answer, on every page">
              <span className="boxmode-label">Boxes</span>
              {BOX_MODES.map((m) => (
                <button key={m.key || 'auto'} type="button" className={boxMode === m.key ? 'on' : ''}
                  aria-pressed={boxMode === m.key} aria-label={`${m.menu}, on every page`}
                  title={`${m.title}, on every page`} onClick={() => switchAllBoxes(m.key)}>
                  <BoxModeLabel mode={m.key} />
                </button>
              ))}
            </div>
          )}
          {pages.length > 1 && (
            <button className={showPages ? 'on' : ''} onClick={() => setShowPages((v) => !v)}>
              Pages <span className="count">{selectedPages.size}/{pages.length}</span>
            </button>
          )}
          <button onClick={reloadDocument} title="Clear everything entered and start this document again">Reload file</button>
          <button className="primary cta" onClick={download}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 4v11M7 10l5 5 5-5" />
              <path d="M4 19h16" />
            </svg>
            Download PDF
          </button>
        </div>
      </header>

      {busy && <div className="busy">{busy}</div>}
      {armedMark && mode !== 'design' && (
        <div className="hintbar markbar">
          Tap the page to put a {MARKS[armedMark].toLowerCase()} there — as many as you like.
          Drag one to move it; tap it and press × to remove it.
          <button className="inlinelink" onClick={() => setArmedMark('')}>Done</button>
        </div>
      )}
      {markDrag && (
        <div className={'markghost ' + (markDrag.mark === '✗' ? 'cross' : 'tick')} aria-hidden="true"
          style={{ left: markDrag.x, top: markDrag.y }}>
          <MarkGlyph mark={markDrag.mark} />
        </div>
      )}
      {updateReady && (
        <div className="updatebar">
          A new version of the app is ready — it loads when you go back to Home.
          <button className="inlinelink" onClick={() => {
            if (window.confirm('Load the new version now? What you have entered on this document will be cleared.')) location.reload()
          }}>Load it now</button>
        </div>
      )}
      {mode === 'design' && (
        <div className="editbar" role="toolbar" aria-label="Edit boxes">
          <span className="editbar-hint">Tap the page to add</span>
          <div className="seg">
            {Object.entries(ADD_KINDS).map(([k, v]) => (
              <button key={k} className={tool === k ? 'on' : ''} aria-pressed={tool === k} onClick={() => setTool(k)}>{v.label}</button>
            ))}
          </div>
          {selected ? (
            <>
              <span className="editbar-sep" aria-hidden="true" />
              <span className="editbar-sel">Selected: <b>{selected.label || ADD_KINDS[kindOf(selected)]?.label}</b></span>
              {selected.type !== 'signature' && selected.type !== 'mark' && (
                <div className="seg">
                  {['text', 'status', 'tick'].map((k) => (
                    <button key={k} className={kindOf(selected) === k ? 'on' : ''} onClick={() => retypeField(selected, k)}>{ADD_KINDS[k].label}</button>
                  ))}
                </div>
              )}
              <button className="danger" onClick={() => deleteField(selected.id)}>Delete box</button>
            </>
          ) : (
            <span className="editbar-tip">Tap a box to select it · drag to move · drag its corner to resize</span>
          )}
          <span className="spacer" />
          <button onClick={resetBoxes}>Reset to detected boxes</button>
          <button className="primary" onClick={stopEditing}>Done</button>
        </div>
      )}
      {editsApplied && mode !== 'design' && (
        <div className="applied-bar">✓ Your box changes for this form were put back.
          <button className="inlinelink" onClick={resetBoxes}>Use the detected boxes instead</button>
        </div>
      )}
      {appliedTemplate && (
        <div className="applied-bar">✓ Opened ready to fill — saved layout <b>{appliedTemplate}</b> applied
          {docKey ? <> for <code>{docKey}</code></> : null}.</div>
      )}
      {/* A document converted in the browser looks different from the Word
          original, and the boxes are placed from a re-flowed copy rather than
          the document's own ruled cells. Say so once, here, rather than letting
          it be discovered when the printed form comes out wrong. */}
      {fidelity === 'approximate' && (
        <div className="fidelity-bar warn">
          <b>Approximate copy — not the original document.</b> Rebuilt in the browser: the ruled
          cells, column widths and page breaks are not the document's own. Do not use it as a
          controlled or issued record. For an exact copy, save the Word file as a PDF from Word
          and open that instead.
          <button className="inlinelink" onClick={() => setScreen('settings')}>Set up exact conversion</button>
        </div>
      )}
      {fidelity === 'exact' && missingFonts.length > 0 && (
        <div className="fidelity-bar warn">
          Converted exactly, but <b>{missingFonts.join(', ')}</b> {missingFonts.length === 1 ? 'is' : 'are'} not
          installed on the converter, so some lines may wrap differently.
          <button className="inlinelink" onClick={() => setScreen('settings')}>How to fix</button>
        </div>
      )}
      {fidelity === 'exact' && graphicNotes.length > 0 && (
        <div className="fidelity-bar warn">
          <b>Converted exactly, with a gap.</b> {graphicNotes.join(' ')}
          <button className="inlinelink" onClick={() => setScreen('settings')}>Set up the converter service</button>
        </div>
      )}
      {pages.length > 0 && fields.length === 0 && !busy && (
        <div className="hintbar">
          No fillable boxes were found on this document. It can still be read here; to fill it in,
          open the form's PDF or Word version.
        </div>
      )}

      {showPages && (
        <div className="pagesbar">
          <div className="pagesbar-head">
            <b>Pages to download</b>
            <span className="muted">{selectedPages.size} of {pages.length} selected — untick reading pages, drag ⠿ to reorder</span>
            <span className="spacer" />
            <button onClick={() => setSelectedPages(new Set(pages.map((_, i) => i)))}>All</button>
            <button onClick={() => { const wf = pagesWithFields(); setSelectedPages(wf.size ? wf : new Set([0])) }}>Only pages with fields</button>
            <button className="primary" onClick={() => setShowPages(false)}>Done</button>
          </div>
          <div className="pagesgrid">
            {pageOrder.map((i, pos) => {
              const pg = pages[i]
              if (!pg) return null
              return (
                <div key={i} data-pagepos={pos} className={'pagechip' + (selectedPages.has(i) ? ' on' : '')}>
                  <span className="draghandle" title="Drag to reorder"
                    onPointerDown={(e) => { dragPos.current = pos; e.preventDefault() }}>⠿</span>
                  <label className="pagechip-body">
                    <input type="checkbox" checked={selectedPages.has(i)} onChange={() => togglePage(i)} />
                    {pg.src
                      ? <img src={pg.src} alt="" draggable={false} />
                      : <span className="pagechip-pending" />}
                    <span>{i + 1}{fields.some((f) => f.page === i) ? ' •' : ''}</span>
                  </label>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="stage">
        <div className="pagescroll" onScroll={onStageScroll}>
          {orderedSelection().map((i) => { const pg = pages[i]; return pg ? (
            <div key={i} className="pagewrap">
              <div className={'page' + (mode === 'design' ? ' editing' : '') + (armedMark && mode !== 'design' ? ' placing' : '')} data-page={i} onClick={(e) => onPageClick(e, i)}
                style={{ aspectRatio: `${pg.pxWidth} / ${pg.pxHeight}` }}>
                {pg.src
                  ? <img src={pg.src} alt={`Page ${i + 1}`} draggable={false} />
                  : <div className="pageloading" aria-label={`Page ${i + 1} is still drawing`} />}
                {mode !== 'design' && fields.some((f) => f.page === i && f.type === 'status') && (
                  <label className={'pagemode' + (modeOfPage(i) ? ' set' : '')} title="How the boxes on this page answer"
                    onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                    This page
                    <select value={modeOfPage(i)} onChange={(e) => switchPageBoxes(i, e.target.value)}>
                      {BOX_MODES.map((m) => <option key={m.key || 'auto'} value={m.key}>{m.menu}</option>)}
                    </select>
                  </label>
                )}
                {fields.filter((f) => f.page === i).map((f) => (
                  <FieldView key={f.id} field={f} aspect={pg.pxHeight / pg.pxWidth} mode={mode} tool={tool} locked={locked}
                    selected={f.id === selectedId} boxMode={modeOfPage(i)} onSelect={() => setSelectedId(f.id)}
                    onChange={(patch) => updateField(f.id, patch)} onSign={() => signField(f)}
                    onPointerDown={(e) => onFieldPointerDown(e, f, e.currentTarget.closest('[data-page]'))}
                    onResizeDown={(e) => onFieldPointerDown(e, f, e.currentTarget.closest('[data-page]'), 'resize')}
                    onDelete={() => deleteField(f.id)} />
                ))}
              </div>
            </div>
          ) : null })}
        </div>

      </div>
    </div>
  )
}

// The elapsed clock shown while LibreOffice converts inside the page. It runs
// on its own one-second timer, independent of the engine's callbacks, so it
// keeps counting through a long silent layout stretch — a climbing number is
// the difference between "working on it" and "frozen". The percentage beside
// it is the engine's last reported stage position.
function ConvertTimer({ startedAt, pct, stageChangedAt }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  // Same step for a long time → say so, and say what happens next. The
  // pictures this engine build used to stall on (PNG/JPEG/EMF anywhere in the
  // document) are re-encoded before it sees them, so a stall now means
  // something new; the converter stops itself after STALL_LIMIT_MS on one
  // step. Slow is normal; this only speaks up when the engine has stopped
  // reporting steps.
  const stalledFor = stageChangedAt ? now - stageChangedAt : 0
  const limitMin = Math.round(STALL_LIMIT_MS / 60000)
  return (
    <>
      <div className="openingtimer">
        <b>{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`}</b>
        {pct > 0 && <span className="openingtimer-pct">{Math.round(pct * 100)}%</span>}
      </div>
      {stalledFor > 150000 && (
        <p className="convwarn openingstall">
          Stuck on the same step for {Math.floor(stalledFor / 60000)} minutes. LibreOffice has
          stopped reporting progress, which usually means it has hit something this engine
          build cannot handle. If it is still on this step at {limitMin} minutes it is stopped
          automatically and the other routes are offered. Press Cancel to stop it now: the
          converter service handles every document in seconds, and a PDF saved from Word
          (File → Save as → PDF) opens directly with nothing to install.
        </p>
      )}
    </>
  )
}

// Whether a box is wide enough to show its label as a hint. Twelve narrow
// columns of "Volta" "Volta" "Volta" across the performance test run table
// said nothing the row label beside them does not; the label is still the
// box's tooltip.
function hintFits(f) {
  const label = String(f.label || '')
  return f.wPct >= 0.09 || label.length <= 8
}

function clamp(v, lo, hi) {
  v = Number(v)
  if (Number.isNaN(v)) v = lo
  return Math.min(Math.max(v, lo), hi)
}

// ---- one field, rendered on the page -------------------------------------
function FieldView({ field: f, aspect = 1.414, mode, tool, locked, selected, boxMode = '', onSelect, onChange, onSign, onPointerDown, onResizeDown, onDelete }) {
  // The type is sized from the box itself (a share of its height, in units
  // of the page's width), so a value fits its cell at any zoom — a fixed 13px
  // overflowed the performance test run table's short rows on a phone and
  // looked lost in the tall ones on a desktop. styles.css clamps it.
  const style = {
    left: `${f.xPct * 100}%`, top: `${f.yPct * 100}%`,
    width: `${f.wPct * 100}%`, height: `${f.hPct * 100}%`,
    '--fh': `${(f.hPct * aspect * 100).toFixed(3)}cqw`,
  }
  const designMove = mode === 'design' && !locked
  const cls = `field ${f.type}${selected ? ' selected' : ''}${designMove ? ' movable' : ''}`
  const readOnly = mode === 'fill' && locked && f.type !== 'signature'

  if (mode === 'design') {
    const kind = kindOf(f)
    const shown = kind === 'mark' ? f.value
      : kind === 'tick' ? (f.value || '')
      : kind === 'status' ? (f.value || (f.options?.length ? f.options.join(' / ') : 'OK / N/A / Fail'))
        : kind === 'signature' ? '✎ Signature'
          : (f.value || f.label || 'Text')
    return (
      <div className={`${cls} editing ${kind}`} style={style} title={f.label}
        onClick={(e) => { e.stopPropagation(); onSelect() }}
        onPointerDown={designMove ? onPointerDown : undefined}>
        <span className="ghost">{shown}</span>
        {selected && (
          <>
            <button type="button" className="fx-del" aria-label="Delete this box"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDelete?.() }}>×</button>
            <span className="fx-resize" aria-hidden="true"
              onPointerDown={(e) => { e.stopPropagation(); onResizeDown?.(e) }} />
          </>
        )}
      </div>
    )
  }
  // A tick or cross dropped on the page: drawn over the page, dragged to
  // move, and removed with × once tapped.
  if (f.type === 'mark') {
    return (
      <div className={`${cls} mark ${f.value === '✗' ? 'cross' : 'tick'} movable`} style={style} title={f.label}
        onClick={(e) => { e.stopPropagation(); onSelect() }}
        onPointerDown={readOnly ? undefined : onPointerDown}>
        <MarkGlyph mark={f.value} />
        {selected && !readOnly && (
          <button type="button" className="fx-del" aria-label={`Remove this ${String(f.label || 'mark').toLowerCase()}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete?.() }}>×</button>
        )}
      </div>
    )
  }
  return (
    <div className={cls} style={style} onClick={(e) => e.stopPropagation()}>
      {/* A box two or more lines tall (Action Taken, Remarks, Comments) takes
          several lines, which the download wraps inside it the same way. */}
      {f.type === 'text' && (f.hPct * aspect > 0.045
        ? <textarea className="ctl area" value={f.value} disabled={readOnly} title={f.label}
            placeholder={hintFits(f) ? f.label : ''} onChange={(e) => onChange({ value: e.target.value })} />
        : <input className="ctl" value={f.value} disabled={readOnly} title={f.label}
            placeholder={hintFits(f) ? f.label : ''} onChange={(e) => onChange({ value: e.target.value })} />
      )}
      {f.type === 'dropdown' && (
        <select className="ctl" value={f.value} disabled={readOnly}
          onChange={(e) => onChange({ value: e.target.value })}>
          <option value="">— select —</option>
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
      {f.type === 'status' && (
        // On a page set to typing, a tap box becomes a plain text box so
        // figures (readings, measurements) can be typed instead of tapped.
        // Any keyboard, not the number pad: a typed status is as often "OK",
        // "N/A" or a note as it is a figure.
        boxMode === 'type' ? (
          <input className="ctl" value={String(f.value ?? '')} disabled={readOnly} title={f.label}
            placeholder={f.label && f.label !== 'Result' && hintFits(f) ? f.label : ''}
            onChange={(e) => onChange({ value: e.target.value })} />
        ) : (
          <StatusCell f={f} boxMode={boxMode} disabled={readOnly} onChange={onChange} />
        )
      )}
      {f.type === 'checkgroup' && (
        <div className="checkgroup">
          {['OK', 'N/A', 'Fail'].map((o) => (
            <button key={o} disabled={readOnly} className={f.value === o ? 'on ' + o : ''}
              onClick={() => onChange({ value: f.value === o ? '' : o })}>{o}</button>
          ))}
        </div>
      )}
      {f.type === 'signature' && (
        f.value
          ? <div className="sigdone"><b>{f.value.name}</b><small>{f.value.timestamp}</small></div>
          : <button className="signbtn" onClick={onSign}>✎ Sign here</button>
      )}
    </div>
  )
}

// A tap box: each tap moves it on through its cycle, which is the page's way
// of answering (ticks, or OK / N/A / Fail) or, on Auto, the box's own.
function StatusCell({ f, boxMode, disabled, onChange }) {
  const cycle = cycleFor(f, boxMode)
  const tick = cycle === TICK_CYCLE
  const v = f.value
  return (
    <button className={'statuscell ' + statusClass(v) + (tick ? ' tick' : '')} disabled={disabled}
      title={tick ? `${f.label || 'Tick'} — tap: tick, cross, clear`
        : 'Tap: ' + cycle.filter(Boolean).join(' → ') + ' → blank'}
      aria-label={tick ? `${f.label || 'Tick box'}: ${v === '✓' ? 'ticked' : v === '✗' ? 'crossed' : v || 'empty'}` : undefined}
      onClick={() => onChange({ value: nextStatus(v, cycle) })}>
      {v === '✓' || v === '✗' ? <MarkGlyph mark={v} /> : (v || (tick ? '' : '–'))}
    </button>
  )
}

// The face of each "Boxes" choice in the toolbar.
function BoxModeLabel({ mode }) {
  if (mode === 'type') return <><span className="typeall-key" aria-hidden="true">123</span>Type</>
  if (mode === 'tick') {
    return (
      <span className="boxmode-marks" aria-hidden="true">
        <span className="tick"><MarkGlyph mark="✓" /></span><span className="cross"><MarkGlyph mark="✗" /></span>
      </span>
    )
  }
  if (mode === 'status') return <>OK · N/A · Fail</>
  return <>Auto</>
}
