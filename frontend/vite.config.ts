import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()], cacheDir: process.env.DELIVERY_MONITOR_CACHE_DIR || 'node_modules/.vite', server: { host: '127.0.0.1', port: 4318, strictPort: true }, build: { outDir: process.env.DELIVERY_MONITOR_BUILD_DIR || 'dist' } })
