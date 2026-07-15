# ASAaei

App for the **SharePoint → edit/sign document → N: drive → SAP work-order close** workflow.

This repo currently contains **Phases 1–2**: a browser-based, **offline-capable (installable
PWA)** tool to open a PDF **or Word doc**, add prefillable fields (text, dropdowns, OK/Fail/N/A
tick boxes) and signatures, save the layout as a **reusable form template**, then fill, lock,
and download a finished PDF. It runs on iPad, tablet, and desktop with no server.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full design, the build phases,
and the questions to send IT/Basis for the SharePoint, N: drive, and SAP integrations.

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

## What works today (Phases 1–2)

- Open a **PDF or Word (.docx)** file — Word is converted to PDF in the browser — or start blank.
- **Design form:** place text fields, dropdowns, OK/Fail/N/A groups, and signature blocks;
  drag to position; set labels and dropdown options.
- **Opens ready to fill:** the app recognises a form by its document number (e.g. `AEI 3.4106`)
  and, if you've saved a layout for it before, **re-applies that layout automatically** and opens
  in fill mode — so after a one-time setup, that form is always ready. See "Auto-detect" and
  "Save as template" below.
- **Auto-detect fields (Word *and* PDF):** when a document is opened, the app pre-places the
  fields for you — OK/Fail/N/A dropdowns in the status columns (including 1M/3M/6M/1Y), text
  fields for Remarks/comments and details blocks (Site name, SAP ID, Date…), and signature blocks
  — then drops you into fill mode. Word docs are read from their table structure; PDFs use their
  embedded form fields when present, otherwise the table/details are reconstructed from the PDF
  text. (Detection is best-effort; the saved-layout recognition above is the reliable path.)
- **Tap OK / Fail / N/A:** status cells are a single tap-cycle — blank → **OK** → **Fail** →
  **N/A** → blank — so a whole column is a few taps, no dropdowns.
- **Profile autofill:** set your name + SAP ID once on the home screen; every form opens with your
  name, SAP ID and today's date already filled in.
- **Page picker:** long procedures have many reading pages before the fillable ones. The **Pages**
  button lets you keep only the pages you fill; the app defaults to the pages that have fields.
  Your selection is saved with the template.
- **Work-order search (SAP + Document Centre):** enter a work order on the home screen and the
  app looks it up in SAP, automatically finds the matching form in the Document Centre, and opens
  it prefilled. This needs the in-network service in [`server/`](server/README.md); until it's
  configured the search box is a clearly-labelled preview.
- **Save as template:** store a form's field layout and reuse it — technicians pick a template
  from the home screen and just fill the latest document. Templates export/import as files.
- **Fill & sign:** fill in the fields on any device; sign with name + date/time (Outlook-style).
- **Finalize & lock:** locks the fields so the document can no longer be edited — only further
  signatures may be added.
- **Download PDF:** exports a flattened (non-editable) PDF.
- **Offline / installable:** "Add to Home Screen" and run with no connection after the first
  load. The latest document is fetched when online and cached for offline use. *(Offline mode
  needs the app served over http(s) — an internal host is fine; it does not work from `file://`.)*

## Not yet built (later phases — need IT access)

- Pull source documents from SharePoint / "Horizons" (Phase 3).
- Automatic save to the N: drive (Phase 4).
- Close SAP IW32/IW42 work orders (Phase 5).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details and the IT/Basis access questions.
