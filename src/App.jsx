import React, { useCallback, useEffect, useRef, useState } from 'react'
import { startPdfRender, revokePageImages } from './pdfRender.js'
import { bakePdf } from './bake.js'
import { fileToPdfBytes } from './convert.js'
import { loadTemplate, saveTemplate, findTemplateByDocKey } from './store.js'
import { getProfile, setProfile, applyProfile } from './profile.js'
import DocEditor from './DocEditor.jsx'
import Settings from './Settings.jsx'
import { discoverConverter, getConverterSettings, lastConverterStatus } from './converter.js'
import { wasmAvailable, deviceEngineEnabled, isolationProblem, STALL_LIMIT_MS } from './wasmConverter.js'

// Build stamp injected by Vite (see vite.config.js). Shown in the UI so the
// running version is identifiable when diagnosing stale caches.
const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'

// ---- field defaults (sizes are fractions of the page) --------------------
const DEFAULT_SIZE = {
  text: { wPct: 0.28, hPct: 0.028 },
  dropdown: { wPct: 0.28, hPct: 0.028 },
  status: { wPct: 0.1, hPct: 0.028 },
  checkgroup: { wPct: 0.34, hPct: 0.028 },
  signature: { wPct: 0.26, hPct: 0.08 },
}
const TOOL_LABEL = {
  select: 'Select / Move',
  text: 'Text field',
  status: 'OK / Fail / N/A',
  dropdown: 'Dropdown',
  signature: 'Signature',
}
// What the "open a document" file pickers accept. Legacy .doc is included
// because the LibreOffice converter reads it; without a converter running the
// open path explains that rather than failing obscurely.
const DOC_ACCEPT = '.pdf,.docx,.doc,application/pdf,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword'

// Tri-state tap control: blank → OK → N/A → Fail → blank.
//
// A field may carry its own wording in `options` — a column headed "Pass/Fail"
// taps through Pass / N/A / Fail — so the value written onto the form is the
// one the form itself asks for. No options means this default.
const STATUS_CYCLE = ['', 'OK', 'N/A', 'Fail']
const cycleFor = (f) => (f?.options?.length ? ['', ...f.options] : STATUS_CYCLE)
const nextStatus = (v, cycle = STATUS_CYCLE) =>
  cycle[(cycle.indexOf(v) + 1) % cycle.length]
// CSS class for a status value: 'OK'/'Pass' read as good, 'Fail' as bad.
const statusClass = (v) => {
  if (!v) return 'blank'
  const s = String(v)
  if (/^(ok|pass)$/i.test(s)) return 'OK'
  if (/^fail$/i.test(s)) return 'Fail'
  return 'NA'
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
  const [screen, setScreen] = useState('home') // 'home' | 'editor' | 'edit' | 'settings'
  const [editorInit, setEditorInit] = useState(null) // { html, name } for the doc editor
  const [online, setOnline] = useState(navigator.onLine)
  // Whether a LibreOffice converter is reachable. Probed once in the
  // background on load so the home screen can say which kind of conversion the
  // next Word file will get, before the user commits to opening one.
  const [converter, setConverter] = useState(lastConverterStatus)
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
  const [mode, setMode] = useState('design')
  const [tool, setTool] = useState('select')
  const [selectedId, setSelectedId] = useState(null)
  const [locked, setLocked] = useState(false)
  const [busy, setBusy] = useState('')
  const [docKey, setDocKey] = useState('')
  const [docTitle, setDocTitle] = useState('')
  const [appliedTemplate, setAppliedTemplate] = useState('') // name of an auto-applied layout
  const [selectedPages, setSelectedPages] = useState(new Set()) // page indices to fill
  const [pageOrder, setPageOrder] = useState([]) // original page indices in display order
  const [showPages, setShowPages] = useState(false)
  const [manualPages, setManualPages] = useState(new Set()) // pages where status cells are typed, not tapped
  const [profile, setProfileState] = useState(getProfile())
  const updateProfile = (patch) => {
    const p = { ...profile, ...patch }
    setProfileState(p); setProfile(p)
  }

  const fileRef = useRef(null)
  const pendingRef = useRef(null) // { action }
  const dragRef = useRef(null)
  // The in-flight page render, so opening another document can stop it and
  // reclaim its images rather than leaving them drawing into nothing.
  const renderRef = useRef(null)
  // Lets the opening screen's Cancel actually stop the work in flight.
  const openJobRef = useRef(null)

  const selected = fields.find((f) => f.id === selectedId) || null

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // Look for a converter in the background. This never blocks anything: the app
  // is fully usable while it runs, and a negative answer only means Word files
  // take the in-browser path.
  useEffect(() => { discoverConverter().then(setConverter) }, [])

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
    setManualPages(new Set())
    setSelectedId(null)
    setTool('select')
    setScreen('editor')
  }, [])

  // Central open path. LIVE DETECTION ALWAYS WINS: the fields are read fresh
  // from this document every time, so a re-issued/edited form just works with no
  // setup. A saved layout is only a silent fallback for a form the detector
  // can't read — it never overrides good detection (which would go stale when
  // the document changes). Used by the "Fill out a document" flow.
  const openDocument = useCallback(async (bytes, name, meta = {}) => {
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
    // Fill the tech's own recurring fields (name, SAP ID, date) up front.
    fields = applyProfile(fields, getProfile())
    setAppliedTemplate(applied)
    await showBytesInEditor(bytes, name, {
      fields, mode: fields.length ? 'fill' : 'design', resetLock: true, pages,
      fidelity, missingFonts, graphicNotes,
    })
  }, [showBytesInEditor])

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
      setConverter(found)
      if (!found.ok) {
        setApproxAsk({ file, reason: found.reason, fix: found.fix })
        setScreen('approx')
        return
      }
    }
    beginOpen(file)
  }

  const beginOpen = async (file) => {
    const p = pendingRef.current || { action: 'new' }
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
      detail: isWord && converter?.ok
        ? `Using ${converter.info?.engine || 'LibreOffice'} — the layout will match Word exactly.`
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
      if (p.action === 'new') {
        // Recognise the form and auto-apply a saved layout if we have one;
        // otherwise fall back to auto-detected fields (or a clean canvas).
        await openDocument(bytes, file.name, { autoFields, docKey: dk, docTitle: dt, ...provenance })
      } else if (p.action === 'reload') {
        // keep existing fields/values
        await showBytesInEditor(bytes, file.name, { ...provenance })
      }
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

  // ---- document editor ----------------------------------------------------
  // Open the Word/Adobe-style editor. Starts blank; the editor itself can open
  // a .docx or a previously-saved .html to edit.
  const openEditor = () => {
    setEditorInit({ html: '', name: 'document' })
    setScreen('edit')
  }

  const saveAsTemplate = async () => {
    if (!fields.length) { alert('Add some fields first.'); return }
    const name = window.prompt('Name this form template (e.g. “Pump Inspection Sheet”):', docTitle || fileName)
    if (!name) return
    await saveTemplate(name.trim(), fields, {
      docKey, docTitle, pages: [...selectedPages].sort((a, b) => a - b),
    })
    setAppliedTemplate(name.trim())
    alert(docKey
      ? `Saved “${name}”. Next time you open ${docKey} it will open ready to fill.`
      : `Saved “${name}”. It will be re-applied to a form this one can be recognised by.`)
  }

  // ---- placing / editing fields (design mode) -----------------------------
  const onPageClick = (e, pageIndex) => {
    if (mode !== 'design' || tool === 'select') return
    const rect = e.currentTarget.getBoundingClientRect()
    const size = DEFAULT_SIZE[tool]
    const field = {
      id: nextId(), type: tool, page: pageIndex,
      xPct: clamp((e.clientX - rect.left) / rect.width, 0, 1 - size.wPct),
      yPct: clamp((e.clientY - rect.top) / rect.height, 0, 1 - size.hPct),
      ...size,
      label: TOOL_LABEL[tool],
      options: tool === 'dropdown' ? ['Option 1', 'Option 2', 'Option 3'] : [],
      value: tool === 'signature' ? null : '',
    }
    setFields((f) => [...f, field])
    setSelectedId(field.id)
    setTool('select')
  }
  const updateField = (id, patch) =>
    setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  const deleteField = (id) => {
    setFields((fs) => fs.filter((f) => f.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  // drag to move (pointer events → works with touch)
  const onFieldPointerDown = (e, field, pageEl) => {
    if (mode !== 'design' || tool !== 'select') return
    e.stopPropagation()
    setSelectedId(field.id)
    dragRef.current = { id: field.id, pageEl }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current
      if (!d) return
      const rect = d.pageEl.getBoundingClientRect()
      setFields((fs) => fs.map((f) => {
        if (f.id !== d.id) return f
        return {
          ...f,
          xPct: clamp((e.clientX - rect.left) / rect.width - f.wPct / 2, 0, 1 - f.wPct),
          yPct: clamp((e.clientY - rect.top) / rect.height - f.hPct / 2, 0, 1 - f.hPct),
        }
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
  const finalize = () => {
    if (window.confirm('Lock this document? Fields can no longer be edited (signatures may still be added).')) {
      setLocked(true); setMode('fill')
    }
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
  const forceUpdate = async () => {
    setBusy('Fetching the newest version…')
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))
      }
      if (window.caches?.keys) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      }
    } catch { /* a browser that blocks either one still reloads below */ }
    try { sessionStorage.clear() } catch { /* private mode */ }
    location.reload()
  }

  const goHome = () => {
    // Stop drawing pages nobody is looking at any more, and hand back the
    // memory their images hold.
    renderRef.current?.cancel()
    renderRef.current = null
    setPages((old) => { revokePageImages(old); return [] })
    setScreen('home'); setFields([]); setPageOrder([])
    setAppliedTemplate(''); setDocKey(''); setDocTitle(''); setShowPages(false)
    setEditorInit(null)
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
  const togglePageManual = (i) => setManualPages((prev) => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })
  const pagesWithFields = () => new Set(fields.map((f) => f.page))

  // ================= DOCUMENT EDITOR =================
  if (screen === 'edit') {
    return (
      <DocEditor
        initialHtml={editorInit?.html || ''}
        initialName={editorInit?.name || 'document'}
        onExit={goHome}
      />
    )
  }

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

          <div className="approxroute muted">
            <b>3 · LibreOffice inside the website</b>
            <p>
              {deviceEngineEnabled()
                ? isolationProblem()
                : 'The app can also convert with LibreOffice running inside this page — no '
                  + 'install, exact layout, slower. It is switched off in Settings.'}
            </p>
          </div>

          <div className="openingactions approxactions">
            <button onClick={() => { setApproxAsk(null); setScreen('home') }}>Cancel</button>
          </div>
          <p className="approxfoot">
            An approximate copy can still be produced on purpose — <i>Always convert in the
            browser</i>, in Settings. Never for a document that is controlled, issued or held
            as a record.
          </p>
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
          // to start or point at a converter, and the home chip should say so.
          discoverConverter({ force: true }).then(setConverter)
          setScreen('home')
        }}
      />
    )
  }

  // ================= HOME SCREEN =================
  // Deliberately quiet: two things to do, said plainly, with everything else
  // (status, settings, provenance) demoted to the footer where it can be
  // glanced at rather than read. A technician opening this on a tablet in a
  // plant room should see the one button they came for, not a control panel.
  if (screen === 'home') {
    return (
      <div className="landing">
        <input ref={fileRef} type="file" accept={DOC_ACCEPT} hidden onChange={onFileChosen} />

        <div className="landing-inner">
          <header className="landing-head">
            <span className="landing-mark" aria-hidden="true">
              <svg viewBox="0 0 44 44" width="44" height="44">
                <rect x="8" y="4" width="24" height="32" rx="4" fill="#fff" stroke="#c6d0e4" strokeWidth="1.5" />
                <rect x="13" y="11" width="14" height="2.4" rx="1.2" fill="#3b57a6" />
                <rect x="13" y="17" width="14" height="2.4" rx="1.2" fill="#c9d3e6" />
                <rect x="13" y="23" width="9" height="2.4" rx="1.2" fill="#c9d3e6" />
                <path d="M25 30.5 l9.5-9.5 3.5 3.5-9.5 9.5-4.6 1.1z"
                  fill="#e8eefb" stroke="#3b57a6" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </span>
            <h1>ASAaei</h1>
            <button className="ghostbtn" onClick={() => setScreen('settings')}>Settings</button>
          </header>
          <p className="landing-sub">Fill, sign and lock documents — on iPad, tablet or desktop.</p>

          <p className="landing-greeting">
            {profile.name
              ? <>Ready for <b>{profile.name}</b>{profile.sapId ? <> · {profile.sapId}</> : null} — your details go into every
                form as it opens.</>
              : <>Add your name and SAP ID in <button className="inlinelink" onClick={() => setScreen('settings')}>Settings</button> and
                every form will open already filled in.</>}
          </p>

          <div className="choices">
            <button className="choice" onClick={() => pickFile('new')}>
              <span className="choice-icon" aria-hidden="true">
                <svg viewBox="0 0 32 32" width="26" height="26" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 4h12l6 6v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
                  <path d="M19 4v6h6" />
                  <path d="M10 17h9M10 22h6" />
                </svg>
              </span>
              <span className="choice-title">Fill out a document</span>
              <span className="choice-note">
                Open a PDF or Word form. The boxes are found for you — type, tick, sign, then save the finished PDF.
              </span>
              <span className="choice-go">Choose a file</span>
            </button>

            <button className="choice" onClick={openEditor}>
              <span className="choice-icon" aria-hidden="true">
                <svg viewBox="0 0 32 32" width="26" height="26" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M25 5.5a3 3 0 0 1 4.2 4.2L14 25l-5.5 1.5L10 21z" />
                  <path d="M4 28h13" />
                </svg>
              </span>
              <span className="choice-title">Edit a document</span>
              <span className="choice-note">
                Write a new document or open an existing one and change the wording, formatting and layout.
              </span>
              <span className="choice-go">Open the editor</span>
            </button>
          </div>

          {busy && <div className="landing-busy">{busy}</div>}

          <footer className="landing-foot">
            <div className="statusrow">
              <button className={'status ' + (converter == null ? 'wait' : converter.ok ? 'ok' : 'warn')}
                onClick={() => setScreen('settings')}
                title={converter?.ok
                  ? `Word documents convert with ${converter.info?.engine || 'LibreOffice'} — exact layout`
                  : 'Word documents convert in the browser — approximate layout'}>
                <span className="dot" />
                {converter == null ? 'Checking conversion' : converter.ok ? 'Exact Word conversion' : 'Browser conversion'}
              </button>
              <span className={'status ' + (online ? 'ok' : 'warn')}>
                <span className="dot" />{online ? 'Online' : 'Offline — still works'}
              </span>
            </div>
            <p>Documents are opened from this device and saved back to it. Nothing is uploaded.</p>
            <p className="build">
              Build {BUILD_ID}
              <button className="inlinelink" onClick={forceUpdate}>check for update</button>
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
          <button className="link" onClick={goHome}>← Home</button>
          <strong className="brand">ASAaei</strong>
          <span className="file">{fileName}</span>
          {appliedTemplate && <span className="applied-chip" title="Saved layout applied automatically">✓ {appliedTemplate}</span>}
        </div>

        <div className="group modes">
          <button className={mode === 'design' ? 'on' : ''} disabled={locked}
            onClick={() => { setMode('design'); setTool('select') }}>Design form</button>
          <button className={mode === 'fill' ? 'on' : ''}
            onClick={() => { setMode('fill'); setTool('select') }}>Fill &amp; sign</button>
        </div>

        {mode === 'design' && !locked && (
          <div className="group tools">
            {Object.keys(TOOL_LABEL).map((t) => (
              <button key={t} className={tool === t ? 'on' : ''} onClick={() => setTool(t)}>
                {t === 'select' ? '↖' : '＋'} {TOOL_LABEL[t]}
              </button>
            ))}
          </div>
        )}

        <div className="group right">
          {pages.length > 1 && (
            <button className={showPages ? 'on' : ''} onClick={() => setShowPages((v) => !v)}>
              ▤ Pages ({selectedPages.size}/{pages.length})
            </button>
          )}
          {mode === 'design' && !locked && <button onClick={saveAsTemplate}>💾 Save as template</button>}
          <button onClick={() => pickFile('reload')}>↻ Reload file</button>
          {locked && <span className="locked-badge">🔒 Locked</span>}
          {!locked && <button onClick={finalize}>Finalize &amp; lock</button>}
          <button className="primary" onClick={download}>Download PDF</button>
        </div>
      </header>

      {busy && <div className="busy">{busy}</div>}
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
      {mode === 'design' && tool !== 'select' && (
        <div className="hintbar">Tap on the page to place a <b>{TOOL_LABEL[tool]}</b>.</div>
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
              <div className="page" data-page={i} onClick={(e) => onPageClick(e, i)}
                style={{ aspectRatio: `${pg.pxWidth} / ${pg.pxHeight}` }}>
                {pg.src
                  ? <img src={pg.src} alt={`Page ${i + 1}`} draggable={false} />
                  : <div className="pageloading" aria-label={`Page ${i + 1} is still drawing`} />}
                {fields.some((f) => f.page === i && f.type === 'status') && (
                  <label className="manualtoggle" title="Type figures instead of tapping OK / N/A / Fail on this page"
                    onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={manualPages.has(i)} onChange={() => togglePageManual(i)} />
                    123 Manual entry
                  </label>
                )}
                {fields.filter((f) => f.page === i).map((f) => (
                  <FieldView key={f.id} field={f} mode={mode} tool={tool} locked={locked}
                    selected={f.id === selectedId} manual={manualPages.has(i)} onSelect={() => setSelectedId(f.id)}
                    onChange={(patch) => updateField(f.id, patch)} onSign={() => signField(f)}
                    onPointerDown={(e) => onFieldPointerDown(e, f, e.currentTarget.closest('[data-page]'))} />
                ))}
              </div>
            </div>
          ) : null })}
        </div>

        {mode === 'design' && selected && !locked && (
          <aside className="panel">
            <h3>{TOOL_LABEL[selected.type]}</h3>
            <label>Label
              <input value={selected.label}
                onChange={(e) => updateField(selected.id, { label: e.target.value })} />
            </label>
            {selected.type === 'dropdown' && (
              <label>Options (one per line)
                <textarea rows={5} value={selected.options.join('\n')}
                  onChange={(e) => updateField(selected.id, {
                    options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                  })} />
              </label>
            )}
            <div className="sizerow">
              <label>Width %
                <input type="number" min={5} max={100} value={Math.round(selected.wPct * 100)}
                  onChange={(e) => updateField(selected.id, { wPct: clamp(e.target.value / 100, 0.05, 1) })} />
              </label>
              <label>Height %
                <input type="number" min={2} max={40} value={Math.round(selected.hPct * 100)}
                  onChange={(e) => updateField(selected.id, { hPct: clamp(e.target.value / 100, 0.02, 0.4) })} />
              </label>
            </div>
            <button className="danger" onClick={() => deleteField(selected.id)}>Delete field</button>
            <p className="tip">Drag the field on the page to move it.</p>
          </aside>
        )}
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

function clamp(v, lo, hi) {
  v = Number(v)
  if (Number.isNaN(v)) v = lo
  return Math.min(Math.max(v, lo), hi)
}

// ---- one field, rendered on the page -------------------------------------
function FieldView({ field: f, mode, tool, locked, selected, manual, onSelect, onChange, onSign, onPointerDown }) {
  const style = {
    left: `${f.xPct * 100}%`, top: `${f.yPct * 100}%`,
    width: `${f.wPct * 100}%`, height: `${f.hPct * 100}%`,
  }
  const designMove = mode === 'design' && tool === 'select' && !locked
  const cls = `field ${f.type}${selected ? ' selected' : ''}${designMove ? ' movable' : ''}`
  const readOnly = mode === 'fill' && locked && f.type !== 'signature'

  if (mode === 'design') {
    return (
      <div className={cls} style={style}
        onClick={(e) => { e.stopPropagation(); onSelect() }}
        onPointerDown={designMove ? onPointerDown : undefined}>
        <span className="ghost">{f.label}</span>
      </div>
    )
  }
  return (
    <div className={cls} style={style} onClick={(e) => e.stopPropagation()}>
      {f.type === 'text' && (
        <input className="ctl" value={f.value} disabled={readOnly}
          placeholder={f.label} onChange={(e) => onChange({ value: e.target.value })} />
      )}
      {f.type === 'dropdown' && (
        <select className="ctl" value={f.value} disabled={readOnly}
          onChange={(e) => onChange({ value: e.target.value })}>
          <option value="">— select —</option>
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
      {f.type === 'status' && (
        // When the page is in manual-entry mode, a status cell becomes a plain
        // text box so figures (readings, measurements) can be typed instead of
        // tapping OK / N/A / Fail.
        manual ? (
          <input className="ctl" value={String(f.value ?? '')} disabled={readOnly}
            inputMode="numeric" placeholder={f.label && f.label !== 'Result' ? f.label : ''}
            onChange={(e) => onChange({ value: e.target.value })} />
        ) : (
          <button className={'statuscell ' + statusClass(f.value)}
            disabled={readOnly}
            title={'Tap: ' + cycleFor(f).filter(Boolean).join(' → ') + ' → blank'}
            onClick={() => onChange({ value: nextStatus(f.value, cycleFor(f)) })}>
            {f.value || '–'}
          </button>
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
