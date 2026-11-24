import { defineConfig } from 'tsup';

const PUBLIC_ENTRIES = {
  index: 'packages/core/src/index.ts',
  ports: 'packages/core/src/ports.ts',
  lifecycle: 'packages/core/src/lifecycle.ts',
  operator: 'packages/core/src/operator.ts',
  seeds: 'packages/core/src/seeds.ts',
} as const;

const WORKER_ENTRIES = {
  'turn-record-recovery-worker': 'src/persistence/sessions/turn-record-recovery-worker.ts',
  'turn-tombstone-authority-worker': 'src/persistence/sessions/turn-tombstone-authority-worker.ts',
} as const;

const CORE_RUNTIME_EXTERNALS = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@huggingface/transformers',
  '@sinclair/typebox',
  'js-tiktoken',
  'pg',
  'uuid',
  'winston',
];

export default defineConfig({
  entry: {
    ...PUBLIC_ENTRIES,
    ...WORKER_ENTRIES,
  },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  splitting: true,
  sourcemap: true,
  clean: true,
  tsconfig: 'packages/core/tsconfig.json',
  outDir: 'packages/core/dist',
  external: CORE_RUNTIME_EXTERNALS,
  dts: {
    entry: PUBLIC_ENTRIES,
  },
});
