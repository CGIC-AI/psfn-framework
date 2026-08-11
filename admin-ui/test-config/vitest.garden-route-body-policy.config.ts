import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      $lib: new URL('../src/lib', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      'admin-ui/src/lib/api/endpoints/body-policy-conformance.test.ts',
    ],
    testTimeout: 10_000,
  },
});
