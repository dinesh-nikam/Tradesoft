import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The proxy serves the SPA and the API from one origin in production (00 §8); the dev server mirrors that.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist', sourcemap: true },
});
