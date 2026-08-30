import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_PORT = process.env.PORT ?? '8787'

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    // Bind IPv4 loopback explicitly. Left to itself Vite binds [::1] only, so
    // if anything else already holds 0.0.0.0:5173 — a VM port-forwarder, a
    // container, another dev server — the two coexist on different address
    // families and a browser resolving `localhost` to IPv4 silently lands on
    // the other one. Binding the family the browser prefers turns that into an
    // ordinary port collision, and Vite steps to the next free port.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // Anchored regex, not the bare prefix '/api'. A plain prefix also matches
      // sibling modules whose names merely start with "api" — src/web/api.ts is
      // requested as /api.ts — and proxies them to the backend, which 404s and
      // leaves the app a blank page. A leading ^ makes Vite treat the key as a
      // regex, so only real /api/ routes are forwarded.
      '^/api/': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
})
