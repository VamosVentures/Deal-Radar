import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // React app never talks to HubSpot/Microsoft/AI directly —
      // everything goes through the credentialed backend. The target
      // is overridable (VITE_API_PROXY_TARGET) so Playwright E2E runs
      // can point the dev-mode frontend at an isolated backend
      // instance on a different port, instead of the real dev API.
      '/api': process.env.VITE_API_PROXY_TARGET || 'http://localhost:8787',
      '/health': process.env.VITE_API_PROXY_TARGET || 'http://localhost:8787',
    },
  },
})
