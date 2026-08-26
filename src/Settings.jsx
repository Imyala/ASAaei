import React, { useCallback, useEffect, useState } from 'react'
import {
  QUALITY_HELP, QUALITY_LABELS,
  discoverConverter, getConverterSettings, setConverterSettings,
} from './converter.js'
import { isolationProblem, resetWasmEngine } from './wasmConverter.js'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// Everything on this screen is optional. The app works with none of it touched:
// conversion is on Automatic, which finds a converter if one is running and
// quietly uses the in-browser path if not. The screen exists so that when
// something *is* wrong — the converter is on another machine, a font is missing
// and a form is re-wrapping — the reason is visible and fixable, rather than
// being an unexplained difference in the output.

export default function Settings({ onExit, profile, onProfile }) {
  const [settings, setSettings] = useState(getConverterSettings)
  const [status, setStatus] = useState(null)   // health payload, or an error
  const [checking, setChecking] = useState(false)
  const [draftUrl, setDraftUrl] = useState(settings.url)
  const [draftWasm, setDraftWasm] = useState(settings.wasmUrl || '')

  const check = useCallback(async () => {
    setChecking(true)
    try {
      const found = await discoverConverter({ force: true })
      setStatus(found.ok
        ? { ok: true, base: found.base || 'this device', ...found.info }
        : { ok: false, reason: found.reason, fix: found.fix })
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => { check() }, [check])

  const update = (patch) => {
    setSettings(setConverterSettings(patch))
    // The endpoint or the mode changed, so the old verdict is stale.
    setTimeout(check, 0)
  }

  const applyUrl = () => {
    const url = draftUrl.trim().replace(/\/+$/, '')
    setDraftUrl(url)
    update({ url })
  }

  const applyWasm = () => {
    const wasmUrl = draftWasm.trim()
    setDraftWasm(wasmUrl)
    resetWasmEngine()
    setSettings(setConverterSettings({ wasmUrl }))
  }

  return (
    <div className="home settings">
      <header className="homehead">
        <h1>Settings</h1>
        <button onClick={onExit}>← Back</button>
      </header>

      {/* ---- Your details ------------------------------------------------ */}
      <section className="homecard">
        <h2>Your details</h2>
        <p className="cardhint">
          Filled into every form automatically — your name, SAP ID and today’s date.
        </p>
        <div className="worow">
          <label className="fieldlabel">Your name
            <input className="woinput" placeholder="e.g. Jordan Ellis" value={profile.name || ''}
              onChange={(e) => onProfile({ name: e.target.value })} />
          </label>
          <label className="fieldlabel">SAP ID
            <input className="woinput" placeholder="e.g. 100234" value={profile.sapId || ''}
              onChange={(e) => onProfile({ sapId: e.target.value })} />
          </label>
        </div>
      </section>

      {/* ---- Word to PDF conversion --------------------------------------- */}
      <section className="homecard">
        <h2>Word → PDF conversion</h2>
        <p className="cardhint">
          Word documents have to become PDFs before they can be filled in. With the
          converter running, LibreOffice does it — the layout is identical to Word and
          the text stays selectable. Without it, the app converts in the browser, which
          works offline but only approximates the layout.
        </p>

        <ConverterStatus status={status} checking={checking} onRetest={check} />

        <fieldset className="settingfield">
          <legend>How to convert</legend>
          {[
            ['auto', 'Automatic (recommended)', 'Use the converter when it can be reached, otherwise convert in the browser.'],
            ['service', 'Always use the converter', 'Never fall back. Opening a Word file reports an error if the converter is down.'],
            ['browser', 'Approximate copy in the browser',
              'Never contacts a converter. Rebuilds the Word file offline — ruled cells, column '
              + 'widths and page breaks move. Never for a controlled or issued document.'],
          ].map(([value, label, help]) => (
            <label key={value} className={'radiorow' + (settings.mode === value ? ' on' : '')}>
              <input type="radio" name="convmode" value={value}
                checked={settings.mode === value}
                onChange={() => update({ mode: value })} />
              <span>
                <b>{label}</b>
                <small>{help}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="settingfield">
          <legend>PDF quality</legend>
          <div className="segmented">
            {Object.keys(QUALITY_LABELS).map((q) => (
              <button key={q} className={settings.quality === q ? 'on' : ''}
                onClick={() => update({ quality: q })}>{QUALITY_LABELS[q]}</button>
            ))}
          </div>
          <small className="settinghelp">{QUALITY_HELP[settings.quality]}</small>
          <small className="settinghelp">
            Every setting keeps text, tables and lines as vector graphics — this only
            changes how photographs and logos are compressed.
          </small>
        </fieldset>

        <fieldset className="settingfield">
          <legend>Converter address</legend>
          <p className="settinghelp">
            Leave blank to search automatically. Set it when the converter runs on a
            different machine — on a tablet, that is the office computer’s address.
          </p>
          <div className="worow">
            <input className="woinput" placeholder="http://192.168.1.20:8787"
              value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyUrl() }}
              inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            <button onClick={applyUrl} disabled={draftUrl.trim() === settings.url}>Save &amp; test</button>
          </div>
        </fieldset>

        <fieldset className="settingfield">
          <legend>LibreOffice on this device (experimental)</legend>
          <p className="settinghelp">
            The same LibreOffice, compiled to WebAssembly and run on the device itself — no
            converter machine, no install, and once it has downloaded it works with no
            network at all. It is about 237 MB, so it is not built into the app: host the
            engine files somewhere and give the address here. Leave blank and none of it is
            downloaded or used.
          </p>
          <p className="convwarn">
            <b>Too slow for a long procedure.</b> Measured against the converter service on the
            same machine: a one-page document took 1.4 s here versus 0.1 s there; a 34-page AEI
            procedure did not finish in 5 minutes, and a 65-page one did not finish in 30, both
            of which the service converts in under 4 seconds. Useful for a short form on a
            device with no other option; not for the procedures.
          </p>
          <div className="worow">
            <input className="woinput" placeholder="https://files.example.com/libreoffice-wasm/"
              value={draftWasm} onChange={(e) => setDraftWasm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyWasm() }}
              inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            <button onClick={applyWasm} disabled={draftWasm.trim() === (settings.wasmUrl || '')}>
              Save
            </button>
          </div>
          {settings.wasmUrl && isolationProblem() && (
            <p className="convwarn">{isolationProblem()}</p>
          )}
          {settings.wasmUrl && !isolationProblem() && (
            <small className="settinghelp">
              This page is cross-origin isolated, so the engine can run. It is downloaded the
              first time a Word document is opened without a converter reachable.
            </small>
          )}
          <small className="settinghelp">
            The engine carries its own fonts and cannot see the ones installed here, so
            Verdana, Segoe UI and MS Gothic are substituted on every device alike. A
            converter machine that has those fonts licensed is still the exact route.
          </small>
        </fieldset>

        <details className="settinghelpbox">
          <summary>How do I start the converter?</summary>
          <p>On the computer that will do the converting, once:</p>
          <ol>
            <li>Install LibreOffice (free) and, on Linux, <code>python3-uno</code>.</li>
            <li>In the app folder run <code>npm run setup-fonts</code> to install the
              matching fonts.</li>
            <li>Run <code>npm run serve</code> and leave it running.</li>
          </ol>
          <p>
            It prints the addresses it is reachable on. Open one of those on a tablet and
            the app finds the converter by itself — there is nothing to type in here.
          </p>
        </details>
      </section>
    </div>
  )
}

// The one thing this screen must answer at a glance: is high-fidelity
// conversion on right now, and if not, why not?
function ConverterStatus({ status, checking, onRetest }) {
  if (checking && !status) {
    return <div className="convstatus checking">Looking for a converter…</div>
  }
  if (!status) return null

  if (!status.ok) {
    return (
      <div className="convstatus off">
        <div className="convstatus-head">
          <b>Converting in the browser</b>
          <button onClick={onRetest} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
        <p>{status.reason}</p>
        {status.fix && <p className="convfix">{status.fix}</p>}
        <p className="muted">
          Until then, Word documents open with an approximate layout. For a document whose
          layout matters, open it in Word and use <b>File → Save as → PDF</b>, then open that
          PDF here: Word's own PDF is exact, and this app fills PDFs without converting
          anything.
        </p>
      </div>
    )
  }

  const missing = status.fonts?.missing || []
  const approx = status.fonts?.approx || []
  return (
    <div className="convstatus on">
      <div className="convstatus-head">
        <b>✓ High-fidelity conversion is on</b>
        <button onClick={onRetest} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <dl className="convfacts">
        <div><dt>Engine</dt><dd>{status.engine}</dd></div>
        <div><dt>Address</dt><dd>{status.base}</dd></div>
        <div>
          <dt>Speed</dt>
          <dd>{status.warm
            ? `warm — ${status.workers} document${status.workers === 1 ? '' : 's'} at a time`
            : 'cold start per document (install python3-uno to make this fast)'}</dd>
        </div>
        {status.stats?.converted > 0 && (
          <div>
            <dt>Converted</dt>
            <dd>{status.stats.converted} document{status.stats.converted === 1 ? '' : 's'},
              average {(status.stats.avgMs / 1000).toFixed(1)}s</dd>
          </div>
        )}
      </dl>
      {missing.length > 0 && (
        <p className="convwarn">
          No font at all for <b>{missing.join(', ')}</b>. A document using one will render in a
          default typeface and re-flow. Run <code>npm run setup-fonts</code> on the converter
          machine.
        </p>
      )}
      {!missing.length && approx.length > 0 && (
        <p className="convnote">
          {approx.join(', ')} {approx.length === 1 ? 'has' : 'have'} no free width-compatible
          clone, so {approx.length === 1 ? 'it is' : 'they are'} substituted approximately —
          text set in {approx.length === 1 ? 'it' : 'them'} may wrap differently. Install the
          genuine {approx.length === 1 ? 'font' : 'fonts'} for an exact match
          (<code>setup-fonts.sh --from-windows</code>).
        </p>
      )}
    </div>
  )
}
