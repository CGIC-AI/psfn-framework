import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      $lib: new URL('./admin-ui/src/lib', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      'admin-ui/src/lib/accounting/**/*.test.ts',
      'admin-ui/src/lib/api/endpoints/accounting.test.ts',
    ],
    testTimeout: 10_000,
  },
});
