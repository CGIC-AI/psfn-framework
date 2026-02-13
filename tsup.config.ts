import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/gateway-main.ts', 'src/agent-main.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});
