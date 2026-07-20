import React, { useCallback, useEffect, useRef, useState } from 'react'
import { renderPdfToImages } from './pdfRender.js'
import { bakePdf, makeBlankPdf } from './bake.js'
import { fileToPdfBytes } from './convert.js'
import {
  listTemplates, loadTemplate, saveTemplate, deleteTemplate,
  cacheDoc, getCachedDoc, exportTemplate, importTemplateJson, findTemplateByDocKey,
} from './store.js'
import { getProfile, setProfile, applyProfile } from './profile.js'
import DocEditor from './DocEditor.jsx'

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
// Tri-state tap control: blank → OK → N/A → Fail → blank.
const STATUS_CYCLE = ['', 'OK', 'N/A', 'Fail']
const nextStatus = (v) => STATUS_CYCLE[(STATUS_CYCLE.indexOf(v) + 1) % STATUS_CYCLE.length]

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
  const [screen, setScreen] = useState('home') // 'home' | 'editor' | 'edit'
  const [editorInit, setEditorInit] = useState(null) // { html, name } for the doc editor
  const [templates, setTemplates] = useState([])
  const [online, setOnline] = useState(navigator.onLine)

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
  const [activeTemplateId, setActiveTemplateId] = useState(null)
  const [needSource, setNeedSource] = useState(false) // template chosen, waiting for document
  const [cachedDoc, setCachedDoc] = useState(null)
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
  const importRef = useRef(null)
  const pendingRef = useRef(null) // { action, templateId }
  const dragRef = useRef(null)

  const selected = fields.find((f) => f.id === selectedId) || null

  const refreshTemplates = useCallback(async () => setTemplates(await listTemplates()), [])
  useEffect(() => { refreshTemplates() }, [refreshTemplates])
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // ---- rendering a document into the editor -------------------------------
  const showBytesInEditor = useCallback(async (bytes, name, opts) => {
    const imgs = await renderPdfToImages(bytes, 1.5)
    setPdfBytes(bytes)
    setPages(imgs)
    setFileName(name.replace(/\.(pdf|docx)$/i, '') || 'document')
    setNeedSource(false)
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
    const { autoFields = [], docKey: dk = '', docTitle: dt = '' } = meta
    setDocKey(dk); setDocTitle(dt)
    let fields = autoFields.map((f) => ({ ...f, id: nextId() }))
    let pages = null, applied = '', tId = null
    if (fields.length === 0) {
      const match = await findTemplateByDocKey(dk)
      if (match) {
        const tpl = await loadTemplate(match.id)
        fields = instantiate(tpl.fields)
        pages = tpl.pages && tpl.pages.length ? tpl.pages : null
        applied = match.name; tId = match.id
        await cacheDoc(match.id, name, bytes)
      }
    }
    // Fill the tech's own recurring fields (name, SAP ID, date) up front.
    fields = applyProfile(fields, getProfile())
    setActiveTemplateId(tId)
    setAppliedTemplate(applied)
    await showBytesInEditor(bytes, name, {
      fields, mode: fields.length ? 'fill' : 'design', resetLock: true, pages,
    })
  }, [showBytesInEditor])

  // ---- file chosen (new design / reload / apply template) -----------------
  const onFileChosen = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const p = pendingRef.current || { action: 'new' }
    setBusy(/\.docx$/i.test(file.name) ? 'Converting Word document…' : 'Opening document…')
    try {
      const { bytes, autoFields = [], docKey: dk = '', docTitle: dt = '' } = await fileToPdfBytes(file, {
        onProgress: (done, total) => setBusy(`Converting Word document… (page ${Math.min(done + 1, total)} of ${total})`),
      })
      if (p.action === 'new') {
        // Recognise the form and auto-apply a saved layout if we have one;
        // otherwise fall back to auto-detected fields (or a clean canvas).
        await openDocument(bytes, file.name, { autoFields, docKey: dk, docTitle: dt })
      } else if (p.action === 'apply') {
        const tpl = await loadTemplate(p.templateId)
        setActiveTemplateId(p.templateId)
        await cacheDoc(p.templateId, file.name, bytes)
        await showBytesInEditor(bytes, file.name, { fields: instantiate(tpl.fields), mode: 'fill', resetLock: true })
      } else if (p.action === 'reload') {
        if (activeTemplateId) await cacheDoc(activeTemplateId, file.name, bytes)
        await showBytesInEditor(bytes, file.name, {}) // keep existing fields/values
      }
    } catch (err) {
      alert(err.message || 'Could not open that file.')
    } finally {
      setBusy('')
    }
  }

  const pickFile = (action, templateId) => {
    pendingRef.current = { action, templateId }
    fileRef.current?.click()
  }

  // ---- home actions -------------------------------------------------------
  const startBlank = async () => {
    setActiveTemplateId(null)
    setBusy('Preparing…')
    try {
      await showBytesInEditor(await makeBlankPdf(), 'blank-form', { fields: [], mode: 'design', resetLock: true })
    } finally { setBusy('') }
  }

  const useTemplate = async (t) => {
    const cache = await getCachedDoc(t.id)
    setActiveTemplateId(t.id)
    setCachedDoc(cache || null)
    setPages([])
    setNeedSource(true)
    setScreen('editor')
    pendingRef.current = { action: 'apply', templateId: t.id }
    setFileName(t.name)
    // preload the template so "use offline copy" works too
    const tpl = await loadTemplate(t.id)
    pendingRef.current.tpl = tpl
  }

  const useOfflineCopy = async () => {
    const p = pendingRef.current
    const cache = await getCachedDoc(p.templateId)
    const tpl = await loadTemplate(p.templateId)
    setBusy('Opening offline copy…')
    try {
      await showBytesInEditor(cache.bytes, cache.name, { fields: instantiate(tpl.fields), mode: 'fill', resetLock: true })
    } finally { setBusy('') }
  }

  // ---- document editor ----------------------------------------------------
  // Open the Word/Adobe-style editor. Starts blank; the editor itself can open
  // a .docx or a previously-saved .html to edit.
  const openEditor = () => {
    setEditorInit({ html: '', name: 'document' })
    setScreen('edit')
  }

  const onImport = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      await importTemplateJson(await file.text())
      await refreshTemplates()
    } catch (err) { alert(err.message) }
  }

  const doExport = async (t) => {
    const tpl = await loadTemplate(t.id)
    const blob = new Blob([exportTemplate(tpl)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${t.name.replace(/\s+/g, '-')}.template.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const removeTemplate = async (t) => {
    if (window.confirm(`Delete template “${t.name}”? This cannot be undone.`)) {
      await deleteTemplate(t.id); await refreshTemplates()
    }
  }

  const saveAsTemplate = async () => {
    if (!fields.length) { alert('Add some fields first.'); return }
    const name = window.prompt('Name this form template (e.g. “Pump Inspection Sheet”):', docTitle || fileName)
    if (!name) return
    const tpl = await saveTemplate(name.trim(), fields, {
      docKey, docTitle, pages: [...selectedPages].sort((a, b) => a - b),
    })
    setActiveTemplateId(tpl.id)
    setAppliedTemplate(name.trim())
    if (pdfBytes) await cacheDoc(tpl.id, fileName + '.pdf', pdfBytes)
    await refreshTemplates()
    alert(docKey
      ? `Saved “${name}”. Next time you open ${docKey} it will open ready to fill.`
      : `Saved “${name}”. You can now reuse it from the home screen.`)
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
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `${fileName}${locked ? '-signed' : ''}.pdf`; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { alert('Could not build the PDF.\n' + e.message) }
    finally { setBusy('') }
  }

  const goHome = () => {
    setScreen('home'); setPages([]); setFields([]); setPageOrder([]); setNeedSource(false)
    setAppliedTemplate(''); setDocKey(''); setDocTitle(''); setShowPages(false)
    setEditorInit(null); refreshTemplates()
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

  // ================= HOME SCREEN =================
  if (screen === 'home') {
    return (
      <div className="home">
        <input ref={fileRef} type="file" accept=".pdf,.docx,application/pdf" hidden onChange={onFileChosen} />
        <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={onImport} />
        <header className="homehead">
          <h1>ASAaei</h1>
          <span className={'net ' + (online ? 'up' : 'down')}>{online ? '● Online' : '○ Offline'}</span>
        </header>
        <p className="tag">Fill out and edit documents — works offline on iPad, tablet &amp; desktop.</p>

        <section className="actions primary-actions">
          <button className="big primary" onClick={() => pickFile('new')}>
            📝 Fill out a document
            <small>Open a PDF or Word form — fillable boxes are detected automatically, ready to tick, type and sign. For technicians on the job.</small>
          </button>
          <button className="big primary" onClick={openEditor}>
            ✏️ Edit a document
            <small>Open or create a document and change its text, formatting and layout — like Word. For engineers updating forms.</small>
          </button>
        </section>

        <section className="profile">
          <label className="wolabel">Your details <span className="muted">— auto-filled into forms you fill out (name, SAP ID, date)</span></label>
          <div className="worow">
            <input className="woinput" placeholder="Your name" value={profile.name || ''}
              onChange={(e) => updateProfile({ name: e.target.value })} />
            <input className="woinput" placeholder="SAP ID" value={profile.sapId || ''}
              onChange={(e) => updateProfile({ sapId: e.target.value })} />
          </div>
        </section>

        <section className="actions secondary-actions">
          <button className="big" onClick={startBlank}>
            ▢ Blank fillable page<small>Place fields on an empty A4 sheet</small>
          </button>
          <button className="big" onClick={() => importRef.current?.click()}>
            ⇩ Import fill layout<small>Load a saved field layout shared as a file</small>
          </button>
        </section>

        <h2>Saved fill layouts <span className="muted">— optional</span></h2>
        {busy && <div className="busy">{busy}</div>}
        {templates.length === 0 ? (
          <p className="empty">You don’t need any of these. Every form you open is filled in
            <b> automatically</b> — the app reads that document’s own boxes each time, so re-issued
            versions just work with nothing to set up. Saving a layout here is only a fallback for
            an odd form the detector can’t read; it never overrides automatic detection.</p>
        ) : (
          <ul className="tpllist">
            {templates.map((t) => (
              <li key={t.id} className="tplcard">
                <div className="tplmeta">
                  <b>{t.name}</b>
                  <small>{t.fieldCount} fields{t.docKey ? ` · auto-applies to ${t.docKey}` : ''}</small>
                </div>
                <div className="tplactions">
                  <button className="primary" onClick={() => useTemplate(t)}>Use</button>
                  <button onClick={() => doExport(t)}>Export</button>
                  <button className="danger" onClick={() => removeTemplate(t)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">Open documents straight from your device and save the finished file
          wherever you like. Everything runs in your browser — nothing is uploaded.</p>
        <p className="hint" style={{ opacity: 0.6, fontSize: 12 }}>Build {BUILD_ID}</p>
      </div>
    )
  }

  // ================= EDITOR: waiting for source document =================
  if (needSource && !pages.length) {
    return (
      <div className="home">
        <input ref={fileRef} type="file" accept=".pdf,.docx,application/pdf" hidden onChange={onFileChosen} />
        <header className="homehead">
          <h1>{fileName}</h1>
          <button onClick={goHome}>← Home</button>
        </header>
        <p className="tag">Open the document to apply this layout and fill it in.</p>
        <section className="actions">
          <button className="big primary" onClick={() => pickFile('apply', activeTemplateId)}>
            ⇩ Open document<small>Choose the PDF or Word file to fill in with this layout</small>
          </button>
          {cachedDoc && (
            <button className="big" onClick={useOfflineCopy}>
              ▣ Reopen last file<small>Saved {new Date(cachedDoc.savedAt).toLocaleString()}</small>
            </button>
          )}
        </section>
        {busy && <div className="busy">{busy}</div>}
        <p className="hint">If the form has changed, open the current file so the layout matches.</p>
      </div>
    )
  }

  // ================= EDITOR =================
  return (
    <div className="app">
      <input ref={fileRef} type="file" accept=".pdf,.docx,application/pdf" hidden onChange={onFileChosen} />
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
          <button onClick={() => pickFile('reload', activeTemplateId)}>↻ Reload file</button>
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
                    <img src={pg.dataUrl} alt="" draggable={false} />
                    <span>{i + 1}{fields.some((f) => f.page === i) ? ' •' : ''}</span>
                  </label>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="stage">
        <div className="pagescroll">
          {orderedSelection().map((i) => { const pg = pages[i]; return pg ? (
            <div key={i} className="pagewrap">
              <div className="page" data-page={i} onClick={(e) => onPageClick(e, i)}
                style={{ aspectRatio: `${pg.pxWidth} / ${pg.pxHeight}` }}>
                <img src={pg.dataUrl} alt={`Page ${i + 1}`} draggable={false} />
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
          <button className={'statuscell ' + (f.value ? String(f.value).replace('/', '') : 'blank')}
            disabled={readOnly} title="Tap: OK → N/A → Fail"
            onClick={() => onChange({ value: nextStatus(f.value) })}>
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
