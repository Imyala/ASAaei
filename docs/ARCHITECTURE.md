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

Everything runs on the device, in the browser. There is no server and nothing is uploaded; the
user saves the finished file wherever they choose (device, a synced folder, a share, etc.).

## 2. Devices it must run on

Windows desktops, touchscreen/laptops, **and iPads/tablets**. That last one is the deciding
constraint — an iPad can't run a native program — so the app is a **responsive web app** that runs
in any browser and installs as a **PWA** ("Add to Home Screen") for offline use.

## 3. The document engine (the core value)

### Fill

Everything the fill flow needs maps onto standard **PDF form + signature** technology:

| Requirement                                   | How it is done                                             |
|-----------------------------------------------|------------------------------------------------------------|
| Word doc sometimes provided                   | Convert Word → PDF in the browser (mammoth + html2canvas + pdf-lib) |
| Prefillable fields, dropdowns, tick boxes     | Field overlays baked onto the PDF on download              |
| OK / Fail / N/A                               | A single tri-state tap-cell per line item                  |
| Signature with name + date/time (Outlook-like)| A signature block stamped with signer name + timestamp     |
| Locked after signing, except more signatures  | The fields are **flattened** into the PDF on lock          |
| Must be saved as PDF                           | Output is always a flattened PDF                           |

**Auto-detected fields.** When a document is opened, the app pre-places the fields and drops the
user into fill mode. Word docs are read from their table structure; PDFs are read from their
**actual ruled boxes** (drawn table cells) or embedded AcroForm fields. Detection re-runs on every
open, so a re-issued version of a form still fills without any setup.

**Tamper-proofing note:** the app enforces "no longer editable" by flattening the fields on lock.
For legally-robust, tamper-*evident* documents, **cryptographic PDF signatures** (PKI certificate
+ DocMDP field lock) could be added later. That is an upgrade, not required for normal use.

### Edit

The editor works on HTML — the same clean, Word-like HTML the fill pipeline gets from a `.docx`
(via mammoth) — in a `contentEditable` surface with a formatting toolbar. The editing page and the
PDF export share one stylesheet (`DOCX_CSS` in `src/convert.js`), so editing is WYSIWYG with the
output. Exports:

- **PDF** — the same html2canvas → pdf-lib rasteriser the fill flow uses, so a long document builds
  quickly (pages are embedded as JPEG, not PNG) and looks the same as on screen.
- **HTML** — a self-contained file that bundles the stylesheet and re-opens in the editor for
  further editing.

> **Fidelity note.** Word → HTML conversion (mammoth) keeps text, emphasis, headings, lists,
> tables and images, and the app restores a Word-like look (ruled table grids, heading sizes,
> spacing). Very complex Word layouts (exact fonts, multi-column, precise spacing) convert
> approximately; a fully faithful, round-trippable `.docx` export would need a heavier engine
> (e.g. server-side LibreOffice) and is a possible future addition.

## 4. Code map

- **Front-end:** React (Vite), open-source libraries only (no license fees):
  - `pdf-lib` — build/fill/flatten PDFs
  - `pdf.js` (`pdfjs-dist`) — render PDF pages to images for the fill view
  - `mammoth` — Word (`.docx`) → HTML
  - `html2canvas` — rasterise HTML to page images for PDF output
- **Key modules (`src/`):**
  - `convert.js` — Word/HTML → PDF, shared `DOCX_CSS`, field auto-detection for Word tables
  - `DocEditor.jsx` — the document editor (toolbar + contentEditable + PDF/HTML export)
  - `App.jsx` — home screen (Fill vs Edit), the fill editor, page picker, templates
  - `bake.js` — draw field values onto the PDF and flatten
  - `pdfFields.js` / `pdfBoxes.js` / `pdfGrid.js` — PDF field/box detection
  - `store.js` — IndexedDB storage for saved fill layouts (templates)
  - `profile.js` — the user's name / SAP ID / today's date autofill

## 5. Offline / installable

The app is a PWA: installable and fully offline after the first load. A service worker requires the
app to be **served over http(s)** (an internal host is fine) — offline mode does not work from a
bare `file://` copy.
