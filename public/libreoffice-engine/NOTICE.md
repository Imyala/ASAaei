# LibreOffice WebAssembly engine

The files in this directory are the unmodified `assets/` of
[@bentopdf/libreoffice-wasm](https://www.npmjs.com/package/@bentopdf/libreoffice-wasm)
version **2.3.1** — LibreOffice compiled to WebAssembly (via
[@matbee/libreoffice-converter](https://github.com/matbeedotcom/libreoffice-document-converter)),
with the two large files gzip-compressed by the publisher:

| File | What it is |
| --- | --- |
| `soffice.js` | Emscripten loader script |
| `soffice.worker.js` | Emscripten pthread worker stub |
| `soffice.wasm.gz` | The engine itself (~147 MB uncompressed) |
| `soffice.data.gz` | Its fonts and configuration (~100 MB uncompressed) |

They are vendored here so the app is self-contained: the engine is served
from the same origin as the page, with the pinned build on jsDelivr kept only
as an automatic fallback (see `src/wasmConverter.js`). The app decompresses
the `.gz` files in the browser and detects compression by content, so a
server that serves them transparently decompressed also works.

The compressed layout is what makes this possible at all: uncompressed, the
engine exceeds git's 100 MB per-file limit; compressed, the largest file is
~47 MB. Keep bundled and CDN copies on the SAME pinned version — a converted
document's layout must not depend on which source answered.

- License: [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) (LibreOffice)
- Build source: https://github.com/matbeedotcom/libreoffice-document-converter
