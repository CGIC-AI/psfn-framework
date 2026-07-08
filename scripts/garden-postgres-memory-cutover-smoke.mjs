#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const vitestVersion = packageJson.devDependencies?.vitest;
if (typeof vitestVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(vitestVersion)) {
  console.error('Garden Postgres memory cutover smoke requires an exact vitest devDependency pin.');
  process.exit(1);
}

const vitestBin = resolve(
  repoRoot,
  process.platform === 'win32' ? 'node_modules/.bin/vitest.cmd' : 'node_modules/.bin/vitest',
);
if (!existsSync(vitestBin)) {
  console.error('Garden Postgres memory cutover smoke requires installed project dependencies. Run npm ci first.');
  process.exit(1);
}

const smokeTest = 'src/operator/garden/api-routes-postgres-memory-cutover-smoke.test.ts';
const child = spawn(vitestBin, [
  'run',
  smokeTest,
  ...process.argv.slice(2),
], {
  cwd: repoRoot,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Failed to start Garden Postgres memory cutover smoke: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Garden Postgres memory cutover smoke terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
