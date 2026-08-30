# LibreOffice in-browser wrapper

`browser.js` and `browser.worker.global.js` are the browser wrapper of
[@matbee/libreoffice-converter](https://www.npmjs.com/package/@matbee/libreoffice-converter)
version **2.7.2** (`dist/browser.js` and `dist/browser.worker.global.js`,
unmodified), vendored here so the app can drive LibreOffice compiled to
WebAssembly without a build-time dependency on the 250 MB package.

- License: [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/)
- Source: https://github.com/matbeedotcom/libreoffice-document-converter

The engine binaries themselves (soffice.js / soffice.wasm / soffice.data /
soffice.worker.js — LibreOffice, also MPL-2.0) are not in this repository:
they are fetched at run time from the address configured in
`src/wasmConverter.js` (by default the
[@bentopdf/libreoffice-wasm](https://www.npmjs.com/package/@bentopdf/libreoffice-wasm)
package on jsDelivr, which publishes the same build with the two large files
gzip-compressed to fit CDN size limits).
