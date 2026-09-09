import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The build stamp. Shown in the UI and written to version.json so a running
// app can ask the server which build it is serving (the "check for update"
// link on the home screen). BUILD_ID overrides the timestamp for tests.
const BUILD_ID = process.env.BUILD_ID || new Date().toISOString().slice(0, 16).replace('T', ' ')

// Emits version.json next to index.html. It is deliberately not in the
// service worker's precache list (only js/css/html/images are), so a fetch
// for it always goes to the network and answers for the deployed build,
// not the cached one.
const versionFile = () => ({
  name: 'asaaei-version-file',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) })
  },
  // The stamp also goes into index.html itself, so the loading card can say
  // which page was served even when the app's script never arrives.
  transformIndexHtml(html) {
    return html.replace(/%BUILD_ID%/g, BUILD_ID)
  },
})

// PWA + offline: the app installs to the home screen (iPad/tablet/desktop) and
// works with no connection after the first visit. Note: a service worker needs
// the app served over http(s) — offline mode does not work from a file:// path.
export default defineConfig({
  // Use a RELATIVE base so the built asset URLs (./assets/…) resolve against
  // whatever path the site is served from. This makes the same build work at
  // the domain root, at a GitHub Pages project sub-path like /asaaei/, and from
  // any internal share — and is immune to the repo-name casing (imyala/asaaei)
  // that previously produced a blank page when BASE_PATH was hard-coded to
  // /ASAaei/ and every asset 404'd. BASE_PATH still overrides it if ever needed.
  base: process.env.BASE_PATH || './',
  // Stamp the build time into the bundle so the running version is visible in
  // the UI — this makes it obvious when a browser/service-worker is still
  // serving an old cached build after a redeploy.
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  // Cross-origin isolation in dev and preview. The production equivalents are
  // the convert-server's headers and, on hosts that cannot set headers at all
  // (GitHub Pages), the service worker (src/sw.js). Without these the
  // in-website LibreOffice engine has no SharedArrayBuffer and cannot run.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  plugins: [
    react(),
    versionFile(),
    VitePWA({
      // Hand-written worker (src/sw.js): workbox's generated one cannot inject
      // the COOP/COEP headers the in-website LibreOffice engine needs.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      // index.html registers the worker itself, with updateViaCache 'none'
      // and a retry — the generated registerSW.js does neither.
      injectRegister: null,
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'ASAaei Document Forms',
        short_name: 'ASAaei',
        description: 'Fill, sign and lock inspection documents offline.',
        theme_color: '#2a3d73',
        background_color: '#eef1f6',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
})
