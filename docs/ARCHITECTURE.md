# ASAaei — Document Filler

**Status:** Working app
**Audience:** the team building and maintaining this.

---

## 1. What we are building

A single browser app that does one job with documents, from a one-button home screen:

**Fill out a document** — open a Word/PDF form, fill it in with prefillable fields (text,
dropdowns, OK/Fail/N/A tick boxes), sign it (name + date/time, Outlook-style), lock it, and
save the finished **PDF**.

It is built for technicians in the field, so the home screen and Settings are kept to the
minimum: the one button, the technician's name and SAP ID, and converter setup folded away under
an *Advanced* section. (An earlier build also carried a rich-text document editor; it was removed
from the app in favour of that simplicity.)

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

What the detector (`src/pdfGrid.js`, pure and unit-tested; `src/pdfGeometry.js` reads the page)
places on a page:

- **Empty ruled cells** — a box in each, skipping the printed header row (a heading is the whole
  text of its cell, with the table's label column to its left; a task that merely wraps onto a
  line reading "condition" is not a heading), cells that hold text, a picture or an icon, blank
  gutter columns running down beside a nested list, and cells too short to write in. A cell is
  typed into or tapped (OK / N/A / Fail) by its column heading — footnote marks are ignored, so
  "1M±" and "3M\*\*" are frequency columns, and "Result OK/Not OK" is a status heading; a
  narrow column with no status heading is tapped **unless** its row or column asks for a figure
  ("Voltage (R): Volts", "Actual Reading"), in which case it is typed. A "Grading (1-5)" column
  taps through its scale.
- **Tick boxes and units** — a cell holding only "☐" becomes a tick box, and so does every "☐"
  printed inline ("☐ Yes ☐ No", "☐ JSA Completed …"), sized to the printed square; taps go tick,
  cross, clear, and the download draws the tick or cross (as strokes — the standard PDF fonts
  have neither glyph) over the cleared box. Ticks and crosses dragged from the toolbar onto any
  spot are `mark` fields: drawn the same way, and left out of the saved hand edits. A cell holding only a
  right-aligned unit ("V", "[A]", "Sec") gets a typing box in the space before it; a cell
  printed "Done/Not Done" (a thing and its negation) taps through those two.
- **Gaps in text columns** — an empty cell in a column that is otherwise printed text, with
  nothing before it on its row (the clause cell beside a grey section heading, the blank start
  of a row carried over from the previous page), is not an answer box.
- **Shading bands** — Word paints the grey of a shaded row or column as one rectangle across all
  its cells; that rectangle is recognised as a band (its children tile it) and discarded, so
  shaded rows keep their boxes.
- **Prompts in cells** — "Record water added", "Start batteries:", "Comments:" printed inside an
  answer cell get a box beside them (or under them when the cell is narrow). Not a label whose
  answer cell is right beside it ("HMI reading: | ____"), a column of such labels, or a task that
  introduces a list ("Check tank for water. Either:").
- **Write-on lines** — typed runs of underscores, dashes or dots ("Fuel start: ____Litres",
  "Genset:......") and drawn rules with a label beside or above them ("Notes/Remarks:" over rows
  of dashes, "Site:" out at the margin with its line at a tab stop) each get a box; the label is
  the words before the blank, back to the previous blank in the same run of text. A box on a
  drawn rule rises to the top of its label, so it sits level with the words rather than half a
  row below them; a box on a typed line stays inside its table cell. Underscores inside a code
  ("AD__-ASAC-TMC_-____-AIU___") and the rules under a running header or over a footer are not
  write-on lines.

`npm run inspect-pdf form.pdf` runs the same detection over a PDF on disk and prints the fields
page by page, which is how a mis-detection is diagnosed without the app.

**Hand edits** (`src/boxEdits.js`). What detection misses, the tech fixes in *Edit boxes*: a tap
adds a box snapped to the ruled cell under it (`createCellFinder` in `src/pdfBoxes.js` reads a
page's cells on demand), and boxes can be moved, sized, retyped and deleted. The fixes are saved
per form (its document number) as a change list over detection — boxes removed, boxes added —
not as a frozen layout, and re-applied over fresh detection the next time the form opens; a
different page count leaves them unapplied.

**One footer for every page.** Before a Word document is converted (on either route),
`unifyPageFooters` in `src/docxPreflight.js` switches off Word's "different odd and even pages":
the procedures mirror their footer across a printed spread, which on a screen made the page number
jump from left to right on alternate pages. The default (odd-page) header and footer are used
throughout; a first-page header/footer is kept.

Because the LibreOffice route produces a *vector* PDF with real ruled lines, field detection gets
better input from it than from the in-browser route (which measures a re-flowed HTML copy). Better
fidelity and better box placement come from the same change.

**Tamper-proofing note:** the app enforces "no longer editable" by flattening the fields on lock.
For legally-robust, tamper-*evident* documents, **cryptographic PDF signatures** (PKI certificate
+ DocMDP field lock) could be added later. That is an upgrade, not required for normal use.

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
  - `mammoth` — Word (`.docx`) → HTML (fallback route)
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
  - `Settings.jsx` — the user's profile, plus converter status and address under *Advanced*
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
  missing. Each page is bounded on its own instead — and the bound has to clear the densest real
  page: the performance test run table is 12 × 43 = 516 boxes, and a cap of 250 left every
  shaded row of it empty.
- **A cell closes at the next rule across its own column.** Cells used to be read band by band
  between consecutive rules anywhere on the page, so any short line — a link's underline under
  a clause number, a small table nested in the Action Taken column, the split between two
  sub-rows beside a merged cell — cut every column in two and neither half was closed. Whole
  rows (B.2.7, B.2.8; the Day Tank table) opened with no boxes. Now each column pairs a rule with
  the next rule that crosses *it*, and rules are compared as the union of their pieces. The
  cells of a table nested inside a text cell are kept; nested boxes inside an *empty* cell are
  still content-control placeholders and are dropped.
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
  Pass / N/A / Fail rather than stamping "OK" into a form that never uses the word; "Yes/No"
  taps Yes / No / N/A; a "Result" column beside a printed 1–5 scale taps 1–5.
- **A repeated header counts from below.** Rows a table carries over the top of a page sit above
  the header it repeats there; their status comes from that header.

## 8. Offline / installable

The app is a PWA: installable and fully offline after the first load. A service worker requires the
app to be **served over http(s)** (an internal host is fine) — offline mode does not work from a
bare `file://` path. Offline, conversion falls back to the in-browser route automatically and the
app says so.
