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
- **Save as template:** store a form's field layout and reuse it — engineers pick a template
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
