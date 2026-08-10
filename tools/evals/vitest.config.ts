import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['eval/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
