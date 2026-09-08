import React, { useCallback, useEffect, useState } from 'react'
import { discoverConverter, getConverterSettings, setConverterSettings } from './converter.js'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// Kept deliberately small: a technician comes here once, to enter their name
// and SAP ID, and never again. Conversion is automatic — it finds a converter
// if one is running and uses the in-page engine if not — so its controls are
// folded into a single "Advanced" section for whoever sets the office
// converter up. The conversion mode, PDF quality and engine-source options are
// still honoured from stored settings but no longer offered on screen: they
// were places to make a mistake, not choices a technician needs.

export default function Settings({ onExit, profile, onProfile }) {
  const [settings, setSettings] = useState(getConverterSettings)
  const [status, setStatus] = useState(null)   // health payload, or an error
  const [checking, setChecking] = useState(false)
  const [draftUrl, setDraftUrl] = useState(settings.url)

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

      {/* ---- Advanced: converter setup ----------------------------------- */}
      {/* Folded away on purpose. A technician never needs this: conversion is
          automatic and picks the best route by itself. It is here for whoever
          sets up the office converter, so a tablet can be pointed at it. */}
      <section className="homecard">
        <details className="settinghelpbox advanced">
          <summary>Advanced — Word conversion setup</summary>
          <p className="cardhint">
            Word documents are converted to PDF automatically before they are filled in.
            Nothing here needs changing day to day.
          </p>

          <ConverterStatus status={status} checking={checking} onRetest={check} />

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
