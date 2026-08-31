# LibreOffice in-browser wrapper

`browser.js` and `browser.worker.global.js` are the browser wrapper of
[@matbee/libreoffice-converter](https://www.npmjs.com/package/@matbee/libreoffice-converter)
version **2.7.2** (`dist/browser.js` and `dist/browser.worker.global.js`),
vendored here so the app can drive LibreOffice compiled to WebAssembly
without a build-time dependency on the 250 MB package.

`browser.js` is unmodified. `browser.worker.global.js` carries two
performance modifications (per MPL-2.0 §3.2, modifications available here in
source form — this file *is* the distributed source):

- `SAL_LOG="+ALL"` → `SAL_LOG="-INFO-WARN"` — upstream enables the whole of
  LibreOffice's internal debug log; on a long document that formats millions
  of log lines during layout and drowns the conversion in logging overhead.
- The Emscripten module's unconditional `print: console.log, printErr:
  console.error` → no-ops, for the same reason (upstream's own
  `BrowserConverter` already gates these behind `verbose`).

- License: [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/)
- Source: https://github.com/matbeedotcom/libreoffice-document-converter

The engine binaries themselves (soffice.js / soffice.wasm / soffice.data /
soffice.worker.js — LibreOffice, also MPL-2.0) ship with the app in
`public/libreoffice-engine/` (see the NOTICE.md there), with the same build's
[@bentopdf/libreoffice-wasm](https://www.npmjs.com/package/@bentopdf/libreoffice-wasm)
publication on jsDelivr as an automatic fallback.
