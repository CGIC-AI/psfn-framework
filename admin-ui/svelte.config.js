import adapter from '@sveltejs/adapter-static';

export default {
  kit: {
    adapter: adapter({
      fallback: 'index.html',
      // Emit .br/.gz siblings so the Garden server-transport static path can
      // serve precompressed assets over the WAN without recompressing per request.
      precompress: true
    })
  }
};
