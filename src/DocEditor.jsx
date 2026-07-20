import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DOCX_CSS, docxToHtml, htmlToPdf } from './convert.js'

// ---------------------------------------------------------------------------
// Document editor — a Word/Adobe-style rich editor for engineers to update the
// text, formatting and layout of a document (not just fill fields in it).
//
// It edits the same HTML the fill pipeline produces (via mammoth for .docx),
// styled with the shared DOCX_CSS so what you edit is what the exported PDF
// looks like. Everything runs in the browser, offline:
//   • open a .docx (converted with mammoth) or a .html file we exported before
//   • edit with a formatting toolbar (headings, bold/italic/underline, colour,
//     alignment, lists, tables, images, links)
//   • export a print-ready PDF, or a self-contained HTML file that re-opens
//     here for further editing
// Rich-text editing uses document.execCommand: deprecated on paper but still
// implemented across every current browser, and the only zero-dependency way
// to get contentEditable formatting that works offline on iPad and desktop.
// ---------------------------------------------------------------------------

const FONT_SIZES = [
  { label: 'Small', v: '2' },
  { label: 'Normal', v: '3' },
  { label: 'Medium', v: '4' },
  { label: 'Large', v: '5' },
  { label: 'X-Large', v: '6' },
  { label: 'Huge', v: '7' },
]
const BLOCKS = [
  { label: 'Normal text', v: 'P' },
  { label: 'Heading 1', v: 'H1' },
  { label: 'Heading 2', v: 'H2' },
  { label: 'Heading 3', v: 'H3' },
  { label: 'Quote', v: 'BLOCKQUOTE' },
]

// A blank sheet to start from.
const BLANK_HTML = '<p><br></p>'

export default function DocEditor({ initialHtml, initialName, onExit }) {
  const editorRef = useRef(null)
  const fileRef = useRef(null)
  const imgRef = useRef(null)
  const [name, setName] = useState(initialName || 'document')
  const [busy, setBusy] = useState('')
  const [dirty, setDirty] = useState(false)

  // Apply the shared Word-like stylesheet to the on-screen page, once, so the
  // editor renders tables/headings/lists exactly as the exported PDF will
  // (DOCX_CSS is scoped to `.docx-holder`, the class the page carries).
  useEffect(() => {
    const ID = 'asaaei-docx-css'
    if (!document.getElementById(ID)) {
      const el = document.createElement('style')
      el.id = ID
      el.textContent = DOCX_CSS
      document.head.appendChild(el)
    }
  }, [])

  // Load the starting content once. contentEditable is uncontrolled — we set
  // innerHTML directly and never bind it to React state, so typing never fights
  // a re-render.
  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = initialHtml || BLANK_HTML
    // execCommand colour/size should emit CSS (spans), not deprecated <font>.
    try { document.execCommand('styleWithCSS', false, true) } catch { /* older browsers */ }
  }, [initialHtml])

  const focusEditor = () => editorRef.current?.focus()
  const exec = useCallback((command, value = null) => {
    focusEditor()
    try { document.execCommand(command, false, value) } catch { /* unsupported */ }
    setDirty(true)
  }, [])

  const getHtml = () => editorRef.current?.innerHTML || ''

  // ---- open / new --------------------------------------------------------
  const openFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy('Opening…')
    try {
      let html
      if (/\.docx$/i.test(file.name)) {
        html = await docxToHtml(await file.arrayBuffer())
      } else if (/\.html?$/i.test(file.name)) {
        html = extractBody(await file.text())
      } else {
        throw new Error('Open a Word (.docx) or HTML (.html) file to edit.')
      }
      if (editorRef.current) editorRef.current.innerHTML = html || BLANK_HTML
      setName(file.name.replace(/\.(docx|html?)$/i, '') || 'document')
      setDirty(false)
    } catch (err) {
      alert(err.message || 'Could not open that file.')
    } finally {
      setBusy('')
    }
  }

  const newDoc = () => {
    if (dirty && !window.confirm('Start a new blank document? Unsaved changes will be lost.')) return
    if (editorRef.current) editorRef.current.innerHTML = BLANK_HTML
    setName('document')
    setDirty(false)
    focusEditor()
  }

  // ---- insert helpers ----------------------------------------------------
  const insertTable = () => {
    const spec = window.prompt('Table size as rows x columns (e.g. 4x3):', '3x3')
    if (!spec) return
    const m = /^\s*(\d+)\s*[x×,]\s*(\d+)\s*$/i.exec(spec)
    if (!m) { alert('Enter the size like 4x3 (rows x columns).'); return }
    const rows = Math.min(50, Math.max(1, +m[1]))
    const cols = Math.min(20, Math.max(1, +m[2]))
    let html = '<table>'
    for (let r = 0; r < rows; r++) {
      html += '<tr>'
      for (let c = 0; c < cols; c++) html += '<td><br></td>'
      html += '</tr>'
    }
    html += '</table><p><br></p>'
    exec('insertHTML', html)
  }

  const insertImage = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader()
      fr.onload = () => res(fr.result)
      fr.onerror = rej
      fr.readAsDataURL(file)
    })
    exec('insertImage', dataUrl)
  }

  const insertLink = () => {
    const url = window.prompt('Link URL:', 'https://')
    if (url) exec('createLink', url)
  }

  // ---- export ------------------------------------------------------------
  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  const exportPdf = async () => {
    setBusy('Building PDF…')
    try {
      const { bytes } = await htmlToPdf(getHtml(), {
        onProgress: (done, total) => setBusy(`Building PDF… (page ${Math.min(done + 1, total)} of ${total})`),
      })
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${name || 'document'}.pdf`)
    } catch (err) {
      alert('Could not build the PDF.\n' + (err.message || err))
    } finally {
      setBusy('')
    }
  }

  // A self-contained HTML file: bundles the same DOCX_CSS, so it re-opens here
  // (or in any browser) looking exactly as edited, and can be edited again.
  const exportHtml = () => {
    const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="generator" content="ASAaei">
<title>${escapeHtml(name || 'document')}</title>
<style>
body { margin: 0; background: #f2f3f5; }
.docx-holder { max-width: 794px; margin: 24px auto; padding: 56px; background: #fff;
  box-shadow: 0 1px 6px rgba(0,0,0,.15); color: #000;
  font: 14px "Segoe UI", Calibri, system-ui, -apple-system, sans-serif; line-height: 1.4; }
${DOCX_CSS}
</style>
</head>
<body>
<div class="docx-holder">${getHtml()}</div>
</body>
</html>`
    downloadBlob(new Blob([doc], { type: 'text/html' }), `${name || 'document'}.html`)
  }

  return (
    <div className="editor">
      <input ref={fileRef} type="file" accept=".docx,.html,.htm" hidden onChange={openFile} />
      <input ref={imgRef} type="file" accept="image/*" hidden onChange={insertImage} />

      <header className="toolbar editortoolbar">
        <div className="group">
          <button className="link" onClick={onExit}>← Home</button>
          <strong className="brand">ASAaei</strong>
          <input className="docname" value={name} onChange={(e) => setName(e.target.value)}
            aria-label="Document name" />
        </div>
        <div className="group right">
          <button onClick={newDoc}>✧ New</button>
          <button onClick={() => fileRef.current?.click()}>📂 Open</button>
          <button onClick={exportHtml} title="Save an editable copy you can re-open here">⬇ Save (HTML)</button>
          <button className="primary" onClick={exportPdf}>⬇ Export PDF</button>
        </div>
      </header>

      {/* Formatting toolbar. mousedown-preventDefault keeps the editor's text
          selection alive while a button is pressed. */}
      <div className="formatbar" onMouseDown={(e) => e.preventDefault()}>
        <select className="fmtselect" defaultValue="P" title="Paragraph style"
          onChange={(e) => { exec('formatBlock', e.target.value); e.target.blur() }}>
          {BLOCKS.map((b) => <option key={b.v} value={b.v}>{b.label}</option>)}
        </select>
        <select className="fmtselect" defaultValue="3" title="Text size"
          onChange={(e) => { exec('fontSize', e.target.value); e.target.blur() }}>
          {FONT_SIZES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
        <span className="sep" />
        <button title="Bold" onClick={() => exec('bold')}><b>B</b></button>
        <button title="Italic" onClick={() => exec('italic')}><i>I</i></button>
        <button title="Underline" onClick={() => exec('underline')}><u>U</u></button>
        <button title="Strikethrough" onClick={() => exec('strikeThrough')}><s>S</s></button>
        <label className="colorbtn" title="Text colour">A
          <input type="color" onChange={(e) => exec('foreColor', e.target.value)} />
        </label>
        <label className="colorbtn hilite" title="Highlight">▉
          <input type="color" onChange={(e) => exec('hiliteColor', e.target.value)} />
        </label>
        <span className="sep" />
        <button title="Align left" onClick={() => exec('justifyLeft')}>⯇</button>
        <button title="Align centre" onClick={() => exec('justifyCenter')}>≡</button>
        <button title="Align right" onClick={() => exec('justifyRight')}>⯈</button>
        <button title="Justify" onClick={() => exec('justifyFull')}>☰</button>
        <span className="sep" />
        <button title="Bulleted list" onClick={() => exec('insertUnorderedList')}>• List</button>
        <button title="Numbered list" onClick={() => exec('insertOrderedList')}>1. List</button>
        <button title="Decrease indent" onClick={() => exec('outdent')}>⇤</button>
        <button title="Increase indent" onClick={() => exec('indent')}>⇥</button>
        <span className="sep" />
        <button title="Insert table" onClick={insertTable}>▦ Table</button>
        <button title="Insert image" onClick={() => imgRef.current?.click()}>🖼 Image</button>
        <button title="Insert link" onClick={insertLink}>🔗 Link</button>
        <button title="Clear formatting" onClick={() => exec('removeFormat')}>⨯ Clear</button>
        <span className="sep" />
        <button title="Undo" onClick={() => exec('undo')}>↶</button>
        <button title="Redo" onClick={() => exec('redo')}>↷</button>
      </div>

      {busy && <div className="busy">{busy}</div>}

      <div className="editorstage">
        <div
          ref={editorRef}
          className="docx-holder editorpage"
          contentEditable
          suppressContentEditableWarning
          spellCheck
          onInput={() => setDirty(true)}
        />
      </div>
    </div>
  )
}

// Pull the editable body out of a previously-exported (or arbitrary) HTML file.
// Prefer our `.docx-holder` wrapper; fall back to <body>, then the whole string.
function extractBody(htmlText) {
  try {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html')
    const holder = doc.querySelector('.docx-holder')
    if (holder) return holder.innerHTML
    if (doc.body) return doc.body.innerHTML
  } catch { /* fall through */ }
  return htmlText
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ))
}
