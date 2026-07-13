import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { companionServiceWorker } from './vite/companion-service-worker.js';

export default defineConfig({
  plugins: [react(), companionServiceWorker()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
