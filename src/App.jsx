import React, { useCallback, useEffect, useRef, useState } from 'react'
import { renderPdfToImages } from './pdfRender.js'
import { bakePdf, makeBlankPdf } from './bake.js'

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

export default function App() {
  const [pages, setPages] = useState([]) // rendered page images + dims
  const [pdfBytes, setPdfBytes] = useState(null) // original bytes for baking
  const [fileName, setFileName] = useState('document')
  const [fields, setFields] = useState([])
  const [mode, setMode] = useState('design') // 'design' | 'fill'
  const [tool, setTool] = useState('select')
  const [selectedId, setSelectedId] = useState(null)
  const [locked, setLocked] = useState(false)
  const [busy, setBusy] = useState('')
  const dragRef = useRef(null)

  const selected = fields.find((f) => f.id === selectedId) || null

  // ---- load a PDF ---------------------------------------------------------
  const loadBytes = useCallback(async (bytes, name) => {
    setBusy('Rendering document…')
    try {
      const imgs = await renderPdfToImages(bytes, 1.5)
      setPdfBytes(bytes)
      setPages(imgs)
      setFileName(name.replace(/\.pdf$/i, '') || 'document')
      setFields([])
      setSelectedId(null)
      setLocked(false)
      setMode('design')
      setTool('select')
    } catch (e) {
      alert('Could not open that PDF.\n' + e.message)
    } finally {
      setBusy('')
    }
  }, [])

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!/\.pdf$/i.test(file.name)) {
      alert('Please choose a PDF.\n\nWord files are converted to PDF in a later phase — ' +
        'for now, use “Save as PDF” in Word first.')
      return
    }
    const buf = new Uint8Array(await file.arrayBuffer())
    loadBytes(buf, file.name)
  }

  const startBlank = async () => {
    const bytes = await makeBlankPdf()
    loadBytes(bytes, 'blank-form')
  }

  // ---- placing fields -----------------------------------------------------
  const onPageClick = (e, pageIndex) => {
    if (mode !== 'design' || tool === 'select') return
    const rect = e.currentTarget.getBoundingClientRect()
    const xPct = (e.clientX - rect.left) / rect.width
    const yPct = (e.clientY - rect.top) / rect.height
    const size = DEFAULT_SIZE[tool]
    const field = {
      id: nextId(),
      type: tool,
      page: pageIndex,
      xPct: Math.min(Math.max(xPct, 0), 1 - size.wPct),
      yPct: Math.min(Math.max(yPct, 0), 1 - size.hPct),
      ...size,
      label: TOOL_LABEL[tool],
      options: tool === 'dropdown' ? ['Option 1', 'Option 2', 'Option 3'] : [],
      value: tool === 'signature' ? null : tool === 'checkgroup' ? '' : '',
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

  // ---- drag to move (mouse + touch via pointer events) --------------------
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
      setFields((fs) =>
        fs.map((f) => {
          if (f.id !== d.id) return f
          const xPct = (e.clientX - rect.left) / rect.width - f.wPct / 2
          const yPct = (e.clientY - rect.top) / rect.height - f.hPct / 2
          return {
            ...f,
            xPct: Math.min(Math.max(xPct, 0), 1 - f.wPct),
            yPct: Math.min(Math.max(yPct, 0), 1 - f.hPct),
          }
        })
      )
    }
    const up = () => (dragRef.current = null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  // ---- fill actions -------------------------------------------------------
  const signField = (field) => {
    const name = window.prompt('Type the signer’s full name:')
    if (!name) return
    updateField(field.id, { value: { name: name.trim(), timestamp: nowStamp() } })
  }

  const finalize = () => {
    const unsigned = fields.filter((f) => f.type === 'signature' && !f.value)
    const msg = unsigned.length
      ? `Lock this document?\n\nAfter locking, fields can no longer be edited. ` +
        `The ${unsigned.length} empty signature field(s) can still be signed.`
      : 'Lock this document? Fields can no longer be edited (signatures may still be added).'
    if (window.confirm(msg)) {
      setLocked(true)
      setMode('fill')
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
      a.href = url
      a.download = `${fileName}${locked ? '-signed' : ''}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('Could not build the PDF.\n' + e.message)
    } finally {
      setBusy('')
    }
  }

  // ---- render -------------------------------------------------------------
  if (!pages.length) {
    return (
      <div className="landing">
        <h1>ASAaei</h1>
        <p className="tag">Document fill, sign &amp; lock — Phase 1 prototype</p>
        <div className="card">
          <label className="btn primary">
            Open a PDF
            <input type="file" accept="application/pdf" onChange={onFile} hidden />
          </label>
          <button className="btn" onClick={startBlank}>Start a blank page</button>
        </div>
        <p className="hint">
          Works in any browser — iPad, tablet, or desktop. Add fillable fields, tick boxes and
          signatures, then lock and download a finished PDF. Saving to the N: drive and closing
          SAP work orders come in later phases (see <code>docs/ARCHITECTURE.md</code>).
        </p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="group">
          <strong className="brand">ASAaei</strong>
          <span className="file">{fileName}.pdf</span>
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
              <div
                className="page"
                data-page={i}
                onClick={(e) => onPageClick(e, i)}
                style={{ aspectRatio: `${pg.pxWidth} / ${pg.pxHeight}` }}
              >
                <img src={pg.dataUrl} alt={`Page ${i + 1}`} draggable={false} />
                {fields.filter((f) => f.page === i).map((f) => (
                  <FieldView
                    key={f.id}
                    field={f}
                    mode={mode}
                    tool={tool}
                    locked={locked}
                    selected={f.id === selectedId}
                    onSelect={() => setSelectedId(f.id)}
                    onChange={(patch) => updateField(f.id, patch)}
                    onSign={() => signField(f)}
                    onPointerDown={(e) =>
                      onFieldPointerDown(e, f, e.currentTarget.closest('[data-page]'))
                    }
                  />
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
                  onChange={(e) =>
                    updateField(selected.id, {
                      options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                    })} />
              </label>
            )}
            <div className="sizerow">
              <label>Width %
                <input type="number" min={5} max={100}
                  value={Math.round(selected.wPct * 100)}
                  onChange={(e) => updateField(selected.id, { wPct: clamp(e.target.value / 100, 0.05, 1) })} />
              </label>
              <label>Height %
                <input type="number" min={2} max={40}
                  value={Math.round(selected.hPct * 100)}
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
  v = Number(v) || lo
  return Math.min(Math.max(v, lo), hi)
}

// ---- one field, rendered on the page -------------------------------------
function FieldView({ field: f, mode, tool, locked, selected, onSelect, onChange, onSign, onPointerDown }) {
  const style = {
    left: `${f.xPct * 100}%`,
    top: `${f.yPct * 100}%`,
    width: `${f.wPct * 100}%`,
    height: `${f.hPct * 100}%`,
  }
  const designMove = mode === 'design' && tool === 'select' && !locked
  const cls = `field ${f.type}${selected ? ' selected' : ''}${designMove ? ' movable' : ''}`
  const readOnly = mode === 'fill' && locked && f.type !== 'signature'

  // DESIGN mode: show a placeholder box; select-tool allows drag.
  if (mode === 'design') {
    return (
      <div className={cls} style={style}
        onClick={(e) => { e.stopPropagation(); onSelect() }}
        onPointerDown={designMove ? onPointerDown : undefined}>
        <span className="ghost">{f.label}</span>
      </div>
    )
  }

  // FILL mode: real controls.
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
            <button key={o} disabled={readOnly}
              className={f.value === o ? 'on ' + o : ''}
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
