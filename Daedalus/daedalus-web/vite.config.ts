import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The browser talks to the Daedalus gateway over REST + WebSocket. In dev both
// are proxied through Vite so the app can use same-origin relative URLs.
const gateway = process.env.DAEDALUS_SERVER ?? 'http://127.0.0.1:3080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/health': { target: gateway, changeOrigin: true },
      '/tasks': { target: gateway, changeOrigin: true, ws: true },
      '/workspace': { target: gateway, changeOrigin: true },
    },
  },
})