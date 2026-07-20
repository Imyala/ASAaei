# ASAaei

A browser-based, **offline-capable (installable PWA)** app for working with documents on any
device — iPad, tablet, or desktop. It does two things, from one home screen:

- **📝 Fill out a document** — open a PDF or Word form, get its fillable boxes detected
  automatically (text, dropdowns, OK/Fail/N/A tap-cells, signatures), fill, sign, lock, and save a
  finished PDF. *For technicians on the job.*
- **✏️ Edit a document** — open or create a document and change its **text, formatting and
  layout**, like Word: headings, bold/italic/underline, colour, alignment, lists, tables and
  images. Export a print-ready PDF, or a re-editable HTML file. *For engineers updating forms.*

Everything runs in the browser. Nothing is uploaded to a server, and you save the finished file
wherever you like.

## Run it locally

```bash
npm install
npm run dev      # opens a local dev server; open the printed URL in a browser
```

To build a static version you can host internally or copy to a share:

```bash
npm run build    # output goes to dist/
npm run preview  # serve the built version to try on other devices on your network
```

## Fill out a document

- Open a **PDF or Word (.docx)** file — Word is converted in the browser — or start from a blank
  fillable page.
- **Auto-detect fields (Word *and* PDF):** the app pre-places the fields and drops you into fill
  mode. For PDFs it reads the document's **actual ruled boxes** and puts a field inside each empty
  one; Word docs are read from their table structure; PDFs with embedded form fields use those
  directly. It classifies each box (OK/Fail/N/A tap-cell for narrow status columns, text for wider
  cells, signature next to a "Signature" label). Detection re-runs on every open, so re-issued
  versions still fill.
- **Design form:** place text fields, dropdowns, OK/Fail/N/A groups, and signature blocks; drag to
  position; set labels and dropdown options.
- **Tap OK / Fail / N/A:** status cells are a single tap-cycle — blank → **OK** → **Fail** →
  **N/A** → blank — so a whole column is a few taps, no dropdowns.
- **Profile autofill:** set your name + SAP ID once on the home screen; every form opens with your
  name, SAP ID and today's date already filled in.
- **Page picker:** keep only the pages you fill; the app defaults to the pages that have fields.
- **Save as a fill layout:** store a form's field layout and reuse it — pick it from the home
  screen and just fill the current document. Layouts export/import as files, and the app can
  re-apply a saved layout automatically when it recognises the form's document number.
- **Fill & sign** on any device; sign with name + date/time (Outlook-style).
- **Finalize & lock:** locks the fields so the document can no longer be edited — only further
  signatures may be added.
- **Save PDF:** exports a flattened (non-editable) PDF.

## Edit a document

- Start blank, or **Open** a Word (`.docx`) or a previously-saved HTML file.
- Rich formatting toolbar: paragraph styles and headings, bold / italic / underline /
  strikethrough, text colour and highlight, alignment, bulleted/numbered lists, indent, tables,
  images, links, and undo/redo.
- **What you see is what you get:** the editing page uses the same stylesheet as the export, so
  the PDF matches the screen.
- **Export PDF** for a print-ready copy, or **Save (HTML)** for a self-contained file that
  re-opens in the editor for further editing.

## Offline / installable

"Add to Home Screen" and run with no connection after the first load. *(Offline mode needs the app
served over http(s) — an internal host is fine; it does not work from a bare `file://` copy.)*

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how the document engine works.
