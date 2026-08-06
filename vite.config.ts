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
      /**
       * The two health ENDPOINTS, not the `/health` prefix.
       *
       * `'/health'` proxied every path beginning with those seven
       * characters — including bare `/health`, which is the Health &
       * Wellness vertical route. Clicking the sidebar link worked
       * (React Router handles it client-side), but loading, refreshing
       * or bookmarking /health hit the backend, which has no such route,
       * and returned a 404 instead of the app. The backend only ever
       * registers /health/live and /health/ready (server/routes/health.ts),
       * so naming them exactly gives the SPA its route back.
       */
      '/health/live': process.env.VITE_API_PROXY_TARGET || 'http://localhost:8787',
      '/health/ready': process.env.VITE_API_PROXY_TARGET || 'http://localhost:8787',
    },
  },
})
