import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { companionServiceWorker } from './vite/companion-service-worker.js';

export default defineConfig({
  base: '/companion-ui/',
  plugins: [react(), companionServiceWorker()],
  define: {
    __PSFN_COMPANION_UI_SW_UPDATE_INTERVAL_MS__: JSON.stringify(60_000),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
