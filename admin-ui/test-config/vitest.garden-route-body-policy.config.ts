import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    tsconfigRaw: '{}',
  },
  resolve: {
    alias: {
      $lib: new URL('../src/lib', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: [
      'admin-ui/src/lib/api/endpoints/body-policy-conformance.test.ts',
      'admin-ui/src/lib/api/endpoints/query-policy-conformance.test.ts',
    ],
    testTimeout: 10_000,
  },
});
