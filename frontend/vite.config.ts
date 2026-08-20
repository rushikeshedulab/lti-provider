import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built output is served by the Express backend from ../public, so the whole
// provider (LTI endpoints + React UI) lives on a single origin: :4000.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/lti': 'http://localhost:4000',
      '/.well-known': 'http://localhost:4000',
    },
  },
});
