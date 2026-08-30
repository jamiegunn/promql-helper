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
    port: 5173,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
})
