import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // React app never talks to HubSpot/Microsoft/AI directly —
      // everything goes through the credentialed backend.
      '/api': 'http://localhost:8787',
    },
  },
})
