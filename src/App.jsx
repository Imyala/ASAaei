import React, { useCallback, useEffect, useRef, useState } from 'react'
import { renderPdfToImages } from './pdfRender.js'
import { bakePdf, makeBlankPdf } from './bake.js'
import { fileToPdfBytes } from './convert.js'
import {
  listTemplates, loadTemplate, saveTemplate, deleteTemplate,
  cacheDoc, getCachedDoc, exportTemplate, importTemplateJson,
} from './store.js'
import { searchWorkOrder, searchDocumentCentre } from './sap.js'

// ---- field defaults (sizes are fractions of the page) --------------------
const DEFAULT_SIZE = {
  text: { wPct: 0.28, hPct: 0.028 },
  dropdown: { wPct: 0.28, hPct: 0.028 },
  checkgroup: { wPct: 0.34, hPct: 0.028 },
  signature: { wPct: 0.26, hPct: 0.08 },
}
const TOOL_LABEL = {
  select: 'Select / Move',
  text: 'Text field',
  dropdown: 'Dropdown',
  checkgroup: 'OK / Fail / N/A',
  signature: 'Signature',
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
  const [screen, setScreen] = useState('home') // 'home' | 'editor'
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

  // work-order (SAP) search
  const [woInput, setWoInput] = useState('')
  const [woBusy, setWoBusy] = useState(false)
  const [woResult, setWoResult] = useState(null)
  const [woNotice, setWoNotice] = useState('') // '' | 'not-configured' | error text

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
    setSelectedId(null)
    setTool('select')
    setScreen('editor')
  }, [])

  // ---- file chosen (new design / reload / apply template) -----------------
  const onFileChosen = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const p = pendingRef.current || { action: 'new' }
    setBusy(/\.docx$/i.test(file.name) ? 'Converting Word document…' : 'Opening document…')
    try {
      const { bytes, autoFields = [] } = await fileToPdfBytes(file)
      if (p.action === 'new') {
        setActiveTemplateId(null)
        // Word docs come back with the fillable cells already detected — drop
        // the tech straight into fill mode when we found any, otherwise open a
        // clean design canvas as before.
        const detected = autoFields.map((f) => ({ ...f, id: nextId() }))
        await showBytesInEditor(bytes, file.name, {
          fields: detected,
          mode: detected.length ? 'fill' : 'design',
          resetLock: true,
        })
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

  // ---- work-order (SAP) search -------------------------------------------
  // Look up the work order in SAP, then automatically search the Document
  // Centre for its form and open it (already prefilled). Falls back to showing
  // details / matches if the form can't be auto-opened.
  const searchWO = async () => {
    setWoNotice(''); setWoResult(null)
    setWoBusy(true)
    try {
      const wo = await searchWorkOrder(woInput)
      setWoResult(wo)
      if (wo.documentQuery) {
        const docs = await searchDocumentCentre(wo.documentQuery)
        if (docs.length) {
          setWoResult({ ...wo, documents: docs })
          await openWorkOrderDoc({ number: wo.number, documentUrl: docs[0].url, documentName: docs[0].fileName })
          return
        }
        setWoNotice(`No matching form found in the Document Centre for WO ${wo.number}.`)
      } else {
        setWoNotice(`WO ${wo.number} has no linked form to search for.`)
      }
    } catch (err) {
      setWoNotice(err.code === 'NOT_CONFIGURED' ? 'not-configured' : (err.message || 'Search failed.'))
    } finally {
      setWoBusy(false)
    }
  }

  // Pull the document linked to a work order and open it (auto-detecting fields,
  // exactly like a manually opened file). Runs once the SAP middleware exists.
  const openWorkOrderDoc = async (wo) => {
    if (!wo?.documentUrl) return
    setBusy('Loading work order document…')
    try {
      const resp = await fetch(wo.documentUrl, { credentials: 'include' })
      if (!resp.ok) throw new Error(`Could not fetch the document (${resp.status}).`)
      const blob = await resp.blob()
      const name = wo.documentName || `WO-${wo.number}.pdf`
      const file = new File([blob], name, { type: blob.type })
      const { bytes, autoFields = [] } = await fileToPdfBytes(file)
      setActiveTemplateId(null)
      const detected = autoFields.map((f) => ({ ...f, id: nextId() }))
      await showBytesInEditor(bytes, name, {
        fields: detected, mode: detected.length ? 'fill' : 'design', resetLock: true,
      })
    } catch (err) {
      alert(err.message || 'Could not open the work order document.')
    } finally {
      setBusy('')
    }
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
    const name = window.prompt('Name this form template (e.g. “Pump Inspection Sheet”):', fileName)
    if (!name) return
    const tpl = await saveTemplate(name.trim(), fields)
    setActiveTemplateId(tpl.id)
    if (pdfBytes) await cacheDoc(tpl.id, fileName + '.pdf', pdfBytes)
    await refreshTemplates()
    alert(`Saved “${name}”. You can now reuse it from the home screen.`)
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
    setBusy('Building PDF…')
    try {
      const out = await bakePdf(pdfBytes, fields)
      const blob = new Blob([out], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `${fileName}${locked ? '-signed' : ''}.pdf`; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { alert('Could not build the PDF.\n' + e.message) }
    finally { setBusy('') }
  }

  const goHome = () => {
    setScreen('home'); setPages([]); setFields([]); setNeedSource(false); refreshTemplates()
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
        <p className="tag">Document fill, sign &amp; lock — works offline on iPad, tablet &amp; desktop.</p>

        <section className="wo">
          <label className="wolabel" htmlFor="wo">Find a work order</label>
          <div className="worow">
            <input id="wo" className="woinput" inputMode="numeric" placeholder="Work order number (e.g. 2112345)"
              value={woInput} onChange={(e) => setWoInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') searchWO() }} />
            <button className="primary" onClick={searchWO} disabled={woBusy}>
              {woBusy ? 'Searching…' : '🔍 Search SAP'}
            </button>
          </div>
          {woNotice === 'not-configured' && (
            <div className="wonotice">
              <b>SAP search isn’t connected yet.</b> When it’s on, you enter a work order and the
              app looks it up in SAP, automatically finds the matching form in the Document Centre,
              and opens it prefilled. It needs the small in-network service in <code>server/</code>
              pointed at SAP + the Document Centre — see <code>docs/ARCHITECTURE.md</code> §8.
            </div>
          )}
          {woNotice && woNotice !== 'not-configured' && <div className="wonotice err">{woNotice}</div>}
          {woResult && (
            <div className="wocard">
              <div className="tplmeta">
                <b>WO {woResult.number}</b>
                <small>{[woResult.description, woResult.equipment, woResult.status].filter(Boolean).join(' · ')}</small>
              </div>
              {woResult.documents?.length ? (
                <div className="woactions">
                  {woResult.documents.slice(0, 3).map((d, i) => (
                    <button key={i} className={i === 0 ? 'primary' : ''}
                      onClick={() => openWorkOrderDoc({ number: woResult.number, documentUrl: d.url, documentName: d.fileName })}>
                      {i === 0 ? 'Open ' : ''}{d.documentNumber || d.title || d.fileName}
                    </button>
                  ))}
                </div>
              ) : <small className="empty">No form linked to this work order.</small>}
            </div>
          )}
        </section>

        <section className="actions">
          <button className="big primary" onClick={() => pickFile('new')}>
            ＋ New form<small>Open a PDF/Word doc and lay out fields</small>
          </button>
          <button className="big" onClick={startBlank}>
            ▢ Blank page<small>Experiment on an empty A4 sheet</small>
          </button>
          <button className="big" onClick={() => importRef.current?.click()}>
            ⇩ Import template<small>Load a template shared as a file</small>
          </button>
        </section>

        <h2>Saved form templates</h2>
        {busy && <div className="busy">{busy}</div>}
        {templates.length === 0 ? (
          <p className="empty">No templates yet. Create a “New form”, add your fields, then
            <b> Save as template</b> — after that, technicians just pick it here and fill the
            latest document.</p>
        ) : (
          <ul className="tpllist">
            {templates.map((t) => (
              <li key={t.id} className="tplcard">
                <div className="tplmeta">
                  <b>{t.name}</b>
                  <small>{t.fieldCount} fields</small>
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
        <p className="hint">Source documents are downloaded fresh each time from the document
          centre (updated often). The last copy is kept for offline use.
          SharePoint/“Horizons”, N: drive save and SAP close-out arrive in later phases —
          see <code>docs/ARCHITECTURE.md</code>.</p>
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
        <p className="tag">Load the current document to fill it in.</p>
        <section className="actions">
          <button className="big primary" onClick={() => pickFile('apply', activeTemplateId)}>
            ⇩ Load latest document<small>Get the up-to-date file from the document centre</small>
          </button>
          {cachedDoc && (
            <button className="big" onClick={useOfflineCopy}>
              ▣ Use offline copy<small>Saved {new Date(cachedDoc.savedAt).toLocaleString()}</small>
            </button>
          )}
        </section>
        {busy && <div className="busy">{busy}</div>}
        <p className="hint">Always load the latest when you have a connection — the offline copy
          may be out of date.</p>
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
          {mode === 'design' && !locked && <button onClick={saveAsTemplate}>💾 Save as template</button>}
          <button onClick={() => pickFile('reload', activeTemplateId)}>↻ Reload latest</button>
          {locked && <span className="locked-badge">🔒 Locked</span>}
          {!locked && <button onClick={finalize}>Finalize &amp; lock</button>}
          <button className="primary" onClick={download}>Download PDF</button>
        </div>
      </header>

      {busy && <div className="busy">{busy}</div>}
      {mode === 'design' && tool !== 'select' && (
        <div className="hintbar">Tap on the page to place a <b>{TOOL_LABEL[tool]}</b>.</div>
      )}

      <div className="stage">
        <div className="pagescroll">
          {pages.map((pg, i) => (
            <div key={i} className="pagewrap">
              <div className="page" data-page={i} onClick={(e) => onPageClick(e, i)}
                style={{ aspectRatio: `${pg.pxWidth} / ${pg.pxHeight}` }}>
                <img src={pg.dataUrl} alt={`Page ${i + 1}`} draggable={false} />
                {fields.filter((f) => f.page === i).map((f) => (
                  <FieldView key={f.id} field={f} mode={mode} tool={tool} locked={locked}
                    selected={f.id === selectedId} onSelect={() => setSelectedId(f.id)}
                    onChange={(patch) => updateField(f.id, patch)} onSign={() => signField(f)}
                    onPointerDown={(e) => onFieldPointerDown(e, f, e.currentTarget.closest('[data-page]'))} />
                ))}
              </div>
            </div>
          ))}
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
function FieldView({ field: f, mode, tool, locked, selected, onSelect, onChange, onSign, onPointerDown }) {
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
      {f.type === 'checkgroup' && (
        <div className="checkgroup">
          {['OK', 'Fail', 'N/A'].map((o) => (
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
