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

## Word → PDF: conversion is built into the website

Word documents have to become PDFs before they can be filled in, and **how** that conversion is
done is the difference between a form that matches the original and one that doesn't. The app
has three routes and picks the best reachable one automatically:

| | **Converter service** | **LibreOffice in the website** | **Approximate (opt-in)** |
|---|---|---|---|
| Layout | **Identical to Word** | **Identical to Word** — same LibreOffice, compiled to WebAssembly | Approximated; text re-flows |
| PDF text | Selectable (vector) | Selectable (vector) | Flat page images |
| Speed (35-page form) | **~1.7 s** | seconds on a desktop; longer on tablets and image-heavy documents | ~30 s+ |
| Field boxes | From the document's own ruled cells | From the document's own ruled cells | Measured off a re-flowed HTML copy |
| Needs | LibreOffice on one machine | Nothing — a one-time ~78 MB download, then works offline | Nothing |
| Used | Whenever it is reachable | Automatically when no service is reachable | Only if selected in Settings |

**Out of the box the app converts exactly with nothing installed**: the website carries the
LibreOffice engine itself (WebAssembly). The first Word document triggers a one-time ~78 MB
engine download from a free public CDN ([jsDelivr](https://www.jsdelivr.com/), serving the
pinned [`@bentopdf/libreoffice-wasm`](https://www.npmjs.com/package/@bentopdf/libreoffice-wasm)
build; the driver is the vendored MPL-2.0 wrapper in `public/libreoffice/` — see its
`NOTICE.md`). The engine is kept in the browser's cache, so afterwards it converts with no
network at all. It is real LibreOffice, so the PDF is vector, the layout is Word's, and the
fill boxes land in the document's real ruled cells — just slowly on long documents, which is
what the converter service remains for.

The approximate in-browser route is a rough working copy, not a substitute: it is never used
automatically. And with no engine and no converter, open the PDF that Word itself produces
(below) — that needs nothing at all.

### Deliberately not Microsoft

The conversion is done by LibreOffice and nothing else. Microsoft's own
services will convert a Word file to a PDF perfectly — Word's *Save as PDF*,
SharePoint's *Download as PDF*, the Graph `?format=pdf` endpoint — and the app
does not use any of them. LibreOffice is [MPL-2.0](https://www.libreoffice.org/licenses/):
it can be run, redistributed and relied on with no licence to negotiate, no
tenant, no account, and no service that can change its terms. For documents
that may be held as records, the conversion step should not depend on somebody
else's product.

(Opening a PDF that Word produced is a different matter — that is just a PDF,
and the app reads it with pdf.js. It is the *converting* that stays ours.)

### The quickest way: one container, one machine

```bash
docker build -t asaaei .
docker run -d --restart unless-stopped -p 8787:8787 --name asaaei asaaei
```

Then open `http://<that-machine>:8787` on every tablet and PC. Nothing is
installed on the devices, exact conversion is on for all of them, and the image
carries the metric-compatible fonts so lines break where Word breaks them.

```bash
docker run --rm asaaei node server/convert-server.mjs --check
```

...prints whether conversion works and, if not, why — including which fonts are
missing. The image carries every font that has a free metric-compatible clone;
see **Fonts decide whether the layout matches** below for the three that do not,
and mount them from a licensed Windows machine if your documents use them:

```bash
docker run -d -p 8787:8787 \
  -v /path/to/windows/fonts:/usr/share/fonts/truetype/msfonts:ro asaaei
```

### Setting it up by hand (once, on one computer)

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

**No administrator rights?** Nothing here needs an installer. Unzip a portable
LibreOffice (and, if Node is not present, a portable Node) and the server finds
it on its own — it looks for `libreoffice/program/soffice` next to the app and
in the working directory, for `LibreOfficePortable/…` in the usual places, and
for a per-user install under `%LOCALAPPDATA%\Programs\LibreOffice`. Anything
else: point `SOFFICE_PATH` at the binary.

Check a machine before relying on it:

```bash
npm run check
```

It finds LibreOffice, starts the workers, converts a test document and prints a
verdict — including which fonts are missing, since a missing font re-wraps the
document and that is a layout change like any other.

`npm run serve` prints the addresses it is reachable on:

```
[asaaei] serving on http://localhost:8787
[asaaei]   on this network: http://192.168.1.20:8787
[asaaei] converter ready — LibreOffice 24.2, 2 worker(s), warm (sub-second)
```

Open one of those addresses on an iPad or another PC and **the app finds the converter by itself** —
it is served from the same address, so there is nothing to configure. The home screen shows
**Exact Word conversion** when it is working.

> **Open the app from that address, not from the hosted copy.** A page served over `https://`
> (the GitHub Pages build) is not allowed by the browser to call a plain `http://` address on
> your network, so the hosted app cannot see a converter running on another machine — it will
> report that there is no converter no matter what you type into *Converter address*. Loading
> the app from `http://<the converter's address>:8787` puts the app and the converter on one
> address and the restriction does not apply. A converter on the *same* machine as the browser
> can be reached from the hosted app, though Chrome may first ask whether the site may reach
> devices on your local network — allow it. (The hosted copy is never left without exact
> conversion either way: with no converter reachable it uses the LibreOffice engine inside the
> website itself — slower, but exact.)

The converter proves itself on start-up by converting a test document before it reports as
ready. A LibreOffice that starts but cannot open documents — `libreoffice-core` installed
without `libreoffice-writer` is the usual cause — is reported as unavailable with that reason,
rather than accepting forms and failing every one of them.

### Fonts decide whether the layout matches

Measured on four real AEI procedures. With Calibri missing, AEI 3.3002 converted
to **80 pages**; with Carlito (Calibri's metric-compatible stand-in) installed it
converted to **79**. A missing font is not a cosmetic difference — it re-wraps
the document and moves the page breaks.

`npm run setup-fonts` covers the ones with free metric-compatible clones:

| Document font | Stand-in | Widths match? |
|---|---|---|
| Calibri | Carlito | yes — line breaks identical |
| Cambria | Caladea | yes |
| Arial / Times New Roman / Courier New | Liberation Sans / Serif / Mono | yes |
| **Verdana** | DejaVu Sans | **no — close proportions only** |
| **Segoe UI** | Noto Sans | **no** |
| **MS Gothic** | — | **no** |

The AEI documents use Verdana and Segoe UI, and neither has a free metric clone.
Two ways to close that gap, both legitimate:

- **Run the converter on Windows.** Verdana, Segoe UI and MS Gothic are already
  licensed and installed there, so the conversion is exact with nothing to copy.
- **Copy the fonts from a licensed Windows machine** to a Linux converter:
  `npm run setup-fonts -- --from-windows`. For a container, mount them read-only
  at `/usr/share/fonts/truetype/msfonts`.

`npm run check` lists what is still missing on any machine, and the app shows the
same list in a banner above a document it converted without them.

### LibreOffice inside the website (on by default)

The same engine compiled to WebAssembly, run in the browser: no converter
machine, no install, and it works with no network once cached. It is **on by
default** — when no converter service is reachable, the app fetches the engine
and converts exactly instead of refusing the document.

How the pieces are hosted, since the engine is ~247 MB and cannot live in this
repository (git refuses files over 100 MB), nor on a free CDN as-is (jsDelivr
stops at 50 MB per file):

- **The wrapper** that drives the engine (`browser.js` +
  `browser.worker.global.js` from
  [`@matbee/libreoffice-converter`](https://www.npmjs.com/package/@matbee/libreoffice-converter),
  MPL-2.0, ~184 KB) is vendored in `public/libreoffice/` and ships with the
  app — see `public/libreoffice/NOTICE.md`.
- **The engine binaries** come from the pinned
  [`@bentopdf/libreoffice-wasm`](https://www.npmjs.com/package/@bentopdf/libreoffice-wasm)
  package on jsDelivr — the identical build with the two big files gzipped so
  every file clears the CDN limit (~78 MB total). The app decompresses them
  with the browser's `DecompressionStream`, hands the engine same-origin
  `blob:` URLs, and keeps the compressed files in the Cache API so the
  download happens once per device. A self-hosted copy can be named in
  Settings for a network that cannot reach the CDN.

The page must be **cross-origin isolated** (`Cross-Origin-Opener-Policy:
same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) because the build
uses threads. Every way the app is served now arranges that by itself: the dev
server and `vite preview` send the headers, `npm run serve` sends them (pass
`--no-isolate` to turn that off), and on a host that cannot set headers at all
— **GitHub Pages** — the app's service worker injects them and the page
reloads itself once, after which the engine runs on the hosted copy too.

**Speed.** Early measurements here were dismal (a 34-page procedure did not
finish in 5 minutes) — that turned out to be the engine bundle shipping with
LibreOffice's entire internal debug log switched on, formatting hundreds of
thousands of lines during layout. With that silenced (see
`public/libreoffice/NOTICE.md`), the same machine converts a 399-page ruled
test form in ~15 s, engine start-up aside. Expect document- and
device-dependent times: seconds for typical forms on a desktop, minutes for
an image-heavy procedure on a modest laptop — the screen shows a ticking
elapsed count the whole way, and Cancel stops it instantly. The converter
service is still an order of magnitude faster and remains the right answer
where one machine can be kept running.

**Known engine limit — images in headers, and EMF.** Bisected against real
conversions: this WASM build's PDF export stalls **indefinitely** on a
document with a picture in the page header or footer, or an EMF graphic
anywhere (both engines published today — matbee 2.7.2 and BentoPDF 2.3.1 —
behave the same; body photos and text-only headers are fine). Formal
procedures often carry exactly that: a logo or classification box in the
header. The app watches for it — when a conversion sits on one step for
over 2½ minutes it says so on the opening screen and points at the routes
that work: the converter service (which handles these documents in
seconds) or the PDF Word itself saves. The engine also carries its own fonts
and cannot see the ones installed on the device, so Verdana, Segoe UI and MS
Gothic are substituted on every device alike.

### No converter, and the layout still has to be exact

Save the PDF from Word itself: **File → Save as → PDF**, then open that PDF here. It is Word's
own rendering, so the layout is exact and the text stays selectable, and the app fills PDFs
without converting anything.

**A Word file is opened exactly or not at all.** With no converter service reachable, the
engine inside the website does the conversion — same LibreOffice, exact layout, just slower.
Only when that engine is switched off in Settings, or the page genuinely cannot run it (a plain
`http://` address on another machine is not a secure context, so the browser withholds the
threading the engine needs), does ASAaei refuse the document and offer these routes — it does
not rebuild it in the browser. An approximate rebuild moves ruled cells, column widths, headers
and page breaks; a controlled document that has moved is not a rougher copy of itself, it is a
different document, and no warning banner makes one safe to sign or file. The in-browser route
still exists for a rough working copy, but only for someone who selects **Approximate copy in
the browser** in Settings, and the result is labelled as not the original wherever it is shown.

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
- **LibreOffice inside the website** — on by default; switch it off, or point it at a
  self-hosted copy of the engine files for a network that cannot reach the CDN.
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
