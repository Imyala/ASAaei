import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

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
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
})
