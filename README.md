# ASAaei

A browser-based, **offline-capable (installable PWA)** app for working with documents on any
device — iPad, tablet, or desktop. It does two things, from one home screen:

- **📝 Fill out a document** — open a PDF or Word form, get its fillable boxes detected
  automatically (text, dropdowns, OK/Fail/N/A tap-cells, signatures), fill, sign, lock, and save a
  finished PDF. *For technicians on the job.*
- **✏️ Edit a document** — open or create a document and change its **text, formatting and
  layout**, like Word: headings, bold/italic/underline, colour, alignment, lists, tables and
  images. Export a print-ready PDF, or a re-editable HTML file. *For engineers updating forms.*

Nothing is uploaded to anyone else's server, and you save the finished file wherever you like.

## Word → PDF: run the converter

Word documents have to become PDFs before they can be filled in, and **how** that conversion is
done is the difference between a form that matches the original and one that doesn't. The app has
two routes and picks the better one automatically:

| | **LibreOffice converter** | **In-browser fallback** |
|---|---|---|
| Layout | **Identical to Word** — real fonts, exact table geometry, headers/footers, page breaks | Approximated; text re-flows |
| PDF text | Selectable and searchable (vector) | Flat page images |
| Speed (35-page form) | **~1.7 s**, and instant on a repeat open | ~30 s+ |
| File size (35-page form) | ~300 KB | several MB |
| Field boxes | Read from the document's own ruled cells | Measured off a re-flowed HTML copy |
| Needs | LibreOffice installed on one machine | Nothing |

The fallback is genuinely usable and completely offline, so **the converter is optional** — but
for the AEI inspection forms it is worth the ten minutes of setup.

### Setting it up (once, on one computer)

```bash
# 1. LibreOffice — the conversion engine (free, open source)
sudo apt install libreoffice-writer python3-uno    # Debian/Ubuntu
#   macOS:   brew install --cask libreoffice
#   Windows: install LibreOffice from libreoffice.org

# 2. The fonts the documents use (this is what keeps the layout identical)
npm run setup-fonts

# 3. Build and serve the app + converter together
npm install
npm run serve
```

`npm run serve` prints the addresses it is reachable on:

```
[asaaei] serving on http://localhost:8787
[asaaei]   on this network: http://192.168.1.20:8787
[asaaei] converter ready — LibreOffice 24.2, 2 worker(s), warm (sub-second)
```

Open one of those addresses on an iPad or another PC and **the app finds the converter by itself** —
it is served from the same address, so there is nothing to configure. The home screen shows
**Exact Word conversion** when it is working.

> `python3-uno` is what makes it fast. It lets the server keep LibreOffice warm and hand it
> documents over a socket, instead of starting LibreOffice from scratch for every file (which costs
> about 1.5 s each time). Without it the converter still works, just slower.

### Fonts matter more than anything else

If LibreOffice hasn't got a font the document asks for, it substitutes another one, the glyph
widths change, and lines re-wrap — tables gain rows and page breaks move. That is almost always
what "the PDF doesn't match Word" turns out to be.

`npm run setup-fonts` installs:

- **Metric-compatible clones** — Carlito for Calibri, Caladea for Cambria, Liberation for
  Arial/Times New Roman/Courier New. Different letterforms, *identical widths*, so line breaks and
  page counts match Word exactly.
- **Close stand-ins** for the fonts with no free clone — Verdana, Tahoma, Segoe UI, Aptos — plus
  the fontconfig rules that actually select them.

For those last ones, the only exact fix is the real font. If you are licensed for them:

```bash
./server/setup-fonts.sh --ms-fonts              # Microsoft core fonts (includes Verdana)
./server/setup-fonts.sh --from-windows /path/to/Windows/Fonts
```

The app tells you when this matters: if a document you open needs a font the converter hasn't got,
a bar names the font and Settings shows how to install it. Nothing is hidden.

## Run it locally

```bash
npm install
npm run dev              # dev server, in-browser conversion only
npm run build            # static build into dist/
npm run serve            # build, then serve dist/ + the converter on one port
npm run convert-server   # the converter alone (if you host dist/ elsewhere)
npm test                 # unit tests
```

`npm run serve` accepts `--port`, `--host`, `--workers` and `--static`.

## Fill out a document

- Open a **PDF or Word (.docx, .doc)** file, or start from a blank fillable page.
  Legacy `.doc` needs the converter; `.docx` works either way.
- **Auto-detect fields (Word *and* PDF):** the app pre-places the fields and drops you into fill
  mode. It reads the document's **actual ruled boxes** and puts a field inside each empty one,
  classifying each (OK/Fail/N/A tap-cell for status columns, text for wider cells, signature next
  to a "Signature" label). PDFs with embedded form fields use those directly. Detection re-runs on
  every open, so re-issued versions still fill.
- **Tap OK / Fail / N/A:** status cells are a single tap-cycle — blank → **OK** → **N/A** →
  **Fail** → blank — so a whole column is a few taps, no dropdowns. A column headed *Pass/Fail*
  taps through **Pass / N/A / Fail** instead, matching the form's own wording.
- **Design form:** place text fields, dropdowns, OK/Fail/N/A groups and signature blocks; drag to
  position; set labels and dropdown options.
- **Profile autofill:** set your name + SAP ID once in Settings; every form opens with your name,
  SAP ID and today's date already filled in.
- **Page picker:** keep only the pages you fill, and drag to reorder.
- **Save as a fill layout:** store a form's field layout for a form the detector can't read. There
  is nothing to pick from — the app re-applies a saved layout on its own when it recognises the
  form's document number.
- **Finalize & lock:** flattens the fields so the document can no longer be edited — only further
  signatures may be added.
- **Save PDF:** exports a flattened PDF, keeping the text selectable when the converter produced it.

## Edit a document

- Start blank, or **Open** a Word (`.docx`) or a previously-saved HTML file.
- Rich formatting toolbar: paragraph styles and headings, bold / italic / underline /
  strikethrough, text colour and highlight, alignment, bulleted/numbered lists, indent, tables,
  images, links, and undo/redo.
- **Export PDF** — through LibreOffice when the converter is reachable, so the PDF has real
  selectable text at a fraction of the size; otherwise the in-browser rasteriser. The app says
  which one it used.
- **Save (HTML)** for a self-contained file that re-opens in the editor for further editing.

## Settings

One screen, reachable from the home header:

- **Your details** — name and SAP ID, filled into forms automatically.
- **How to convert** — Automatic (recommended), Always use the converter, or Always convert in the
  browser.
- **PDF quality** — smaller file / balanced / best quality. This only changes how photographs and
  logos are compressed; text, tables and lines are vector in every setting.
- **Converter address** — leave blank to find it automatically; set it when the converter runs on
  another machine.
- **Live status** — which engine is in use, how fast it is, and any missing fonts.

## Offline / installable

"Add to Home Screen" and run with no connection after the first load. Offline, the app falls back
to in-browser conversion by itself. *(Offline mode needs the app served over http(s) — an internal
host is fine; it does not work from a bare `file://` copy.)*

## Known difference

LibreOffice wraps text inside a fixed-size Word text box where Word lets it overflow. In the AEI
forms this shows up only in the small "OFFICIAL" classification box in the page header, which
renders as "OFFICIA / L". Document body, tables and checklists are unaffected.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how the document engine works.
