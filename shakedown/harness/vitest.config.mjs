import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const harnessVerdictsTest = fileURLToPath(
  new URL('./test/harness-verdicts.test.mjs', import.meta.url),
);

export default defineConfig({
  test: {
    environment: 'node',
    // Only the vitest-style suites; the sibling *.test.mjs files are node:test
    // scripts run directly by the shakedown tooling, not vitest-compatible.
    include: [harnessVerdictsTest],
  },
});
