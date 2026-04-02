import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/app/startup/index.ts',
    'gateway-main': 'src/app/gateway/main.ts',
    'agent-main': 'src/app/agent/main.ts',
    'operator-main': 'src/app/operator/main.ts',
  },
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});
