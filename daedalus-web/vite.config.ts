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
      '/settings': { target: gateway, changeOrigin: true },
      '/session': { target: gateway, changeOrigin: true },
      '/providers': { target: gateway, changeOrigin: true },
      '/models': { target: gateway, changeOrigin: true },
      '/uploads': { target: gateway, changeOrigin: true },
      '/upload': { target: gateway, changeOrigin: true },
      '/attachments': { target: gateway, changeOrigin: true },
      '/tasks': { target: gateway, changeOrigin: true, ws: true },
      '/workspace': { target: gateway, changeOrigin: true },
      // Every first-segment the app calls (see src/api/client.ts) must be
      // listed here, or `npm run dev` fails those calls even with the
      // server running: terminal, extensions, and all domain engines
      // (slides, sheets, dokumen, research) were missing before this.
      '/slides': { target: gateway, changeOrigin: true },
      '/sheets': { target: gateway, changeOrigin: true },
      '/dokumen': { target: gateway, changeOrigin: true },
      '/research': { target: gateway, changeOrigin: true },
      '/terminals': { target: gateway, changeOrigin: true },
      '/conversations': { target: gateway, changeOrigin: true },
      '/extensions': { target: gateway, changeOrigin: true },
      '/review': { target: gateway, changeOrigin: true },
    },
  },
})