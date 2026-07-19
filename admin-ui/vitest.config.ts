import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: 'node',
    include: [
      'src/lib/accounting/{cockpit-contract,event-grid,query-state}.test.ts',
      'src/lib/api/client.test.ts',
      'src/lib/api/endpoints/{accounting,audit-history,prompts,sessions}.test.ts',
      'src/lib/api/websocket.test.ts',
      'src/lib/cache/{local-first,queue-cache,session-cache,telemetry-cache}.test.ts',
      'src/lib/evals/observer-sidecar.test.ts',
      'src/lib/fleet/{companion-scope,portal}.test.ts',
      'src/lib/polling/{garden-queue-refresh,page-adoption,visibility-aware-poller}.test.ts',
      'src/lib/providers/{editor,registry}.test.ts',
      'src/lib/stores/auth-storage.test.ts',
      'src/lib/wishlist/view.test.ts',
      'src/routes/autonomy/autonomy-view.test.ts',
      'src/routes/prompts/page-helpers.test.ts',
      'src/routes/sessions/session-data-loader.test.ts',
    ],
  },
});
