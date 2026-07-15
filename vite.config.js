import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' so the built app also works when opened from a plain file share / N: drive.
export default defineConfig({
  plugins: [react()],
  base: './',
})
