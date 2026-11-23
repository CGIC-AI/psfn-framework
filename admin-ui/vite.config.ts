import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      alias: {
        $lib: 'src/lib'
      },
      preprocess: vitePreprocess({ script: true }),
      adapter: adapter({
        fallback: 'index.html',
        // Emit .br/.gz siblings so the Garden server-transport static path can
        // serve precompressed assets over the WAN without recompressing per request.
        precompress: true
      })
    })
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/chat': 'http://localhost:3001',
      '/static': 'http://localhost:3001'
    }
  }
});
