# ASAaei — Document Filler & Editor

**Status:** Working app
**Audience:** the team building and maintaining this.

---

## 1. What we are building

A single browser app that does two jobs with documents, chosen from the home screen:

1. **Fill out a document** — open a Word/PDF form, fill it in with prefillable fields (text,
   dropdowns, OK/Fail/N/A tick boxes), sign it (name + date/time, Outlook-style), lock it, and
   save the finished **PDF**.
2. **Edit a document** — open or create a document and change its text, formatting and layout
   (headings, styles, tables, images) — a Word/Adobe-style editor — then export a PDF or a
   re-editable HTML file.

The app itself runs entirely on the device — including exact Word → PDF conversion: the website
carries LibreOffice compiled to WebAssembly (`src/wasmConverter.js`), fetched from a CDN on first
use and cached on the device. The only optional server component is the **conversion service**
(§4), which does the same conversion much faster; it stores nothing and is normally run on a
machine the team already owns.

## 2. Devices it must run on

Windows desktops, touchscreen/laptops, **and iPads/tablets**. That last one is the deciding
constraint — an iPad can't run a native program — so the app is a **responsive web app** that runs
in any browser and installs as a **PWA** ("Add to Home Screen") for offline use.

This is also why LibreOffice cannot simply be *installed*: it is a native binary and there is no
iPad build. Two answers coexist: LibreOffice compiled to WebAssembly runs inside the page itself
(exact, slower, nothing to install), and the split in §4 — one ordinary PC on the network doing
the conversion for everyone — remains the fast route for the long procedures.

## 3. The document engine (the core value)

### Fill

Everything the fill flow needs maps onto standard **PDF form + signature** technology:

| Requirement                                   | How it is done                                             |
|-----------------------------------------------|------------------------------------------------------------|
| Word doc sometimes provided                   | Converted to PDF — LibreOffice when available, in-browser otherwise (§4) |
| Prefillable fields, dropdowns, tick boxes     | Field overlays baked onto the PDF on download              |
| OK / Fail / N/A                               | A single tri-state tap-cell per line item                  |
| Signature with name + date/time (Outlook-like)| A signature block stamped with signer name + timestamp     |
| Locked after signing, except more signatures  | The fields are **flattened** into the PDF on lock          |
| Must be saved as PDF                           | Output is always a flattened PDF                           |

**Auto-detected fields.** When a document is opened, the app pre-places the fields and drops the
user into fill mode. Fields are read from the PDF's **actual ruled boxes** (drawn table cells) or
its embedded AcroForm fields. Detection re-runs on every open, so a re-issued version of a form
still fills without any setup.

Because the LibreOffice route produces a *vector* PDF with real ruled lines, field detection gets
better input from it than from the in-browser route (which measures a re-flowed HTML copy). Better
fidelity and better box placement come from the same change.

**Tamper-proofing note:** the app enforces "no longer editable" by flattening the fields on lock.
For legally-robust, tamper-*evident* documents, **cryptographic PDF signatures** (PKI certificate
+ DocMDP field lock) could be added later. That is an upgrade, not required for normal use.

### Edit

The editor works on HTML — the same clean, Word-like HTML the fill fallback gets from a `.docx`
(via mammoth) — in a `contentEditable` surface with a formatting toolbar. Exports:

- **PDF** — the edited HTML is wrapped in an A4 page stylesheet and converted by LibreOffice when
  the service is reachable (vector text, small file), otherwise rasterised in the browser. The
  editor says which route produced the file, because "selectable text" versus "a picture of the
  document" matters to whoever receives it.
- **HTML** — a self-contained file that bundles the stylesheet and re-opens in the editor.

## 4. Conversion: two routes, chosen automatically

```
                       ┌─ reachable ──→ POST /api/convert ──→ LibreOffice (warm pool)
  open a .docx ──→ probe                                        │
                       └─ not reachable ─→ mammoth + html2canvas ┘
                                                                 ↓
                                        PDF ──→ field detection ──→ fill screen
```

### Why LibreOffice

It is the only open-source engine that reads `.docx` with Word-grade fidelity: real fonts, exact
table geometry, headers/footers, page breaks, floating images. It is also what the fallback cannot
be — mammoth reconstructs the document as HTML, which is a different layout engine with different
metrics, so the result is an approximation however much CSS is thrown at it.

### Why it is fast

Two things, both in `server/libreoffice.mjs`:

1. **A warm pool.** `soffice --convert-to pdf` costs ~1.2–1.5 s of process start-up *per document*.
   Instead, N LibreOffice processes are started once with a UNO listener and handed jobs over a
   socket by a persistent Python worker (`server/uno-worker.py`). Each engine gets its own port and
   its own user profile, because two LibreOffice processes sharing a profile refuse to start.
2. **A content cache.** The PDF is keyed by SHA-256 of the source bytes plus the export options, so
   re-opening the same form returns in single-digit milliseconds.

Measured on the AEI sample set (35–80 page procedures): **0.3–5.3 s** cold, **~10 ms** cached.

If `python3-uno` is missing the pool degrades to spawning the CLI per job — slower, but it still
converts. If LibreOffice is missing entirely the service reports itself unavailable and the app
uses the in-browser route.

### Why it is a separate process, not a bundled dependency

The tablet can't run it, and the team shouldn't have to install anything on the tablet. One PC runs
`npm run serve`, which hosts **both** the built app and `/api/convert` on the same port. A tablet
that loads the app has, by construction, already found the converter — same origin, no CORS, no
configuration, nothing for anyone to get wrong.

### Fonts

The single biggest fidelity risk, and the one that looks like a converter bug when it isn't. A
missing font is substituted, glyph widths change, and text re-wraps. The server therefore reads the
font table out of the `.docx` (a zip — parsed directly in `server/fonts.mjs`, no dependency),
compares it against what fontconfig has, and returns the difference in
`X-Convert-Missing-Fonts`. The app shows it. `server/setup-fonts.sh` fixes it.

Metric-compatible clones (Carlito↔Calibri, Liberation↔Arial/Times/Courier, Caladea↔Cambria) are as
good as the real font for layout. Verdana, Tahoma, Segoe UI and Aptos have no free clone, so those
get closest-proportion stand-ins and an honest warning.

## 5. Code map

- **Front-end:** React (Vite), open-source libraries only (no licence fees):
  - `pdf-lib` — build/fill/flatten PDFs
  - `pdf.js` (`pdfjs-dist`) — render PDF pages, and read text + drawn geometry for detection
  - `mammoth` — Word (`.docx`) → HTML (fallback route and the editor)
  - `html2canvas` — rasterise HTML to page images (fallback route)
- **Key modules (`src/`):**
  - `converter.js` — service discovery, settings, convert-with-fallback
  - `wasmConverter.js` — LibreOffice-in-the-browser: engine download/cache/decompress, blob
    wiring, the start-up self-test that every engine must pass (this build's first conversion
    stalls at random), conversion with a stall watchdog and one restart (wrapper vendored in
    `public/libreoffice/`, engine fetched from a CDN)
  - `docxPreflight.js` — rewrites a `.docx` so the WebAssembly engine can read its pictures:
    every bitmap re-encoded as a 32-bit BMP by the browser (the engine deadlocks decoding
    PNG/JPEG/EMF on demand), metafiles blanked and reported
  - `sw.js` — the service worker: offline precache + the COOP/COEP headers that let the
    WebAssembly engine run on hosts that cannot set headers (GitHub Pages)
  - `convert.js` — the conversion routes, shared `DOCX_CSS`, `fileToPdfBytes`
  - `Settings.jsx` — converter status/options and the user's profile
  - `DocEditor.jsx` — the document editor (toolbar + contentEditable + PDF/HTML export)
  - `App.jsx` — home screen, the fill editor, page picker, fill layouts
  - `bake.js` — draw field values onto the PDF and flatten
  - `pdfFields.js` / `pdfBoxes.js` / `pdfGrid.js` — PDF field/box detection
  - `pdfRender.js` — progressive page rendering (geometry first, images behind)
  - `store.js` — IndexedDB storage for saved fill layouts (templates)
  - `profile.js` — the user's name / SAP ID / today's date autofill
- **Converter (`server/`):**
  - `convert-server.mjs` — HTTP: `/api/health`, `/api/convert`, and static hosting of `dist/`
  - `libreoffice.mjs` — the warm pool, the CLI fallback engine, the content cache
  - `uno-worker.py` — the persistent UNO worker that talks to a running LibreOffice
  - `fonts.mjs` — docx font-table reader and the installed-font comparison
  - `setup-fonts.sh` + `fonts/60-asaaei-office-substitutes.conf` — font install and substitution
- **Tests:** `src/pdfGrid.test.mjs` (grid geometry and field placement),
  `server/fonts.test.mjs` (zip reading, font matching). `npm test` runs both.

## 6. Opening a document — why it feels fast

Conversion is only part of the wait, and it used to be the smaller part.

The app previously rendered **every** page to a PNG data URL and showed nothing
until the last one finished. On a 37-page procedure that was ~9 s of dead time
*after* conversion, all of it spent with the home screen still on display and a
single line of small text at the bottom — so a tap that was working looked like
a tap that had half-worked. It also left 6.6 MB of base64 strings in React
state (nearer 15 MB for an 80-page document, which an iPad feels).

Three changes, in `pdfRender.js` and the open path:

1. **The home screen is left immediately.** Choosing a file switches to an
   opening screen with the real stage, a progress bar and a working Cancel.
   Cancellation runs all the way down: an `AbortSignal` aborts the converter
   request, and the in-browser rasteriser checks it between chunks. An abort is
   deliberately *not* treated as "converter unavailable" — otherwise cancelling
   would kick off the browser fallback, i.e. the exact work being cancelled.
2. **Page geometry comes back before any rasterising.** The document is on
   screen and fillable as soon as the page sizes are known; images arrive
   behind it, and rendering follows the scroll position, so jumping to page 30
   does not mean waiting for pages 1-29.
3. **Page images are JPEG object URLs, not PNG data URLs.** Quicker to encode
   and a handle instead of megabytes of string. They are revoked when the
   document closes or another one replaces it.

Measured on the AEI samples, cold cache: first page visible in **1.7-7.1 s**,
where the wait is now the LibreOffice conversion itself. The work after
conversion is ~0.7 s regardless of page count.

## 7. Field detection — the rules that matter

`pdfGrid.js` turns a page's ruled cells into fields. The non-obvious parts, each of which exists
because of a specific way it went wrong on a real form:

- **Per-page caps, never document-wide.** A single global cap (once 800 fields) ran out partway
  through page 25 of a 37-page procedure, so the Appendix C inspection record on pages 26–37 —
  the part the tech actually fills in — opened with no boxes and no indication anything was
  missing. Each page is bounded on its own instead.
- **Split cells are re-joined.** Word draws a checkbox content control as a small square inside the
  answer cell; its edges reconstruct as a second cell, giving two tap-cells in one tick box. Two
  touching empty cells whose combined span matches a width the table uses elsewhere are merged.
- **Header rows get no fields.** A row is a header if it carries a Remarks/Comments title or a
  *paired* status heading ("Pass/Fail", "OK / Fail"). A lone "OK" is deliberately not counted, so
  re-opening a part-filled form can't mistake its own answers for headings. Blank cells at the
  *start* of a table's top row are grouped-header captions, not inputs.
- **Labels come from the row, then the column.** A row label ("SAP ID") drives profile autofill, so
  it wins. Otherwise the column's printed heading is used — in a "Test equipment | Model | Barcode"
  grid there is no row label and the heading is the only thing that says what goes in the box.
- **Status cells carry their column's wording.** A column headed "Pass/Fail" taps through
  Pass / N/A / Fail rather than stamping "OK" into a form that never uses the word.

## 8. Offline / installable

The app is a PWA: installable and fully offline after the first load. A service worker requires the
app to be **served over http(s)** (an internal host is fine) — offline mode does not work from a
bare `file://` path. Offline, conversion falls back to the in-browser route automatically and the
app says so.
