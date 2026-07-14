import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      $lib: new URL('./admin-ui/src/lib', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['admin-ui/src/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
