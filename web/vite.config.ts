import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the SPA runs on :5173 and proxies API calls to the backend, so the browser sees a
// single origin (the refresh cookie is SameSite=Strict and would not be sent cross-origin).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
  build: { outDir: 'dist', sourcemap: true },
});
