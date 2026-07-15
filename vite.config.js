import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// PWA + offline: the app installs to the home screen (iPad/tablet/desktop) and
// works with no connection after the first visit. Note: a service worker needs
// the app served over http(s) — offline mode does not work from a file:// path.
export default defineConfig({
  // GitHub Pages serves project sites from /<repo>/ — set via BASE_PATH in CI.
  // Defaults to '/' for local dev.
  base: process.env.BASE_PATH || '/',
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
