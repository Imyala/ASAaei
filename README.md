# ASAaei

App for the **SharePoint → edit/sign document → N: drive → SAP work-order close** workflow.

This repo currently contains **Phase 1**: a browser-based tool to open a PDF, add prefillable
fields (text, dropdowns, OK/Fail/N/A tick boxes) and signatures, lock the document, and
download a finished PDF. It runs on iPad, tablet, and desktop with no server.

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

## What works today (Phase 1)

- Open any PDF (or start from a blank page).
- **Design form:** place text fields, dropdowns, OK/Fail/N/A groups, and signature blocks;
  drag to position; set labels and dropdown options.
- **Fill & sign:** fill in the fields on any device; sign with name + date/time (Outlook-style).
- **Finalize & lock:** locks the fields so the document can no longer be edited — only further
  signatures may be added.
- **Download PDF:** exports a flattened (non-editable) PDF.

## Not yet built (later phases — need IT access)

- Word → PDF conversion and reusable form templates (Phase 2).
- Pull source documents from SharePoint / "Horizons" (Phase 3).
- Automatic save to the N: drive (Phase 4).
- Close SAP IW32/IW42 work orders (Phase 5).
