import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess({ script: true }),
  kit: {
    adapter: adapter({
      fallback: 'index.html',
      // Emit .br/.gz siblings so the Garden server-transport static path can
      // serve precompressed assets over the WAN without recompressing per request.
      precompress: true
    })
  }
};
