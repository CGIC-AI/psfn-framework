import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

test('imported packages are ordinary monorepo paths with one tracker authority', () => {
  const index = execFileSync('git', ['ls-files', '-s'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.doesNotMatch(index, /^160000 /mu);
  assert.equal(existsSync(join(repoRoot, 'tools/evals/.gitmodules')), false);
  assert.equal(existsSync(join(repoRoot, 'apps/satellite-hub/.beads')), false);
});

test('eval TypeScript imports resolve inside the monorepo', () => {
  const files = execFileSync('git', ['ls-files', '--', 'tools/evals/eval'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim().split('\n').filter((path) => path.endsWith('.ts'));
  const source = files.map(read).join('\n');
  assert.doesNotMatch(source, /psfn-framework\/src/u);
  assert.match(read('tools/evals/eval/ttft-real-providers.ts'), /\.\.\/\.\.\/\.\.\/src\//u);
});

test('active integration surfaces use in-repo Hub ownership', () => {
  const active = [
    'README.md',
    'companion-ui/README.md',
    'apps/satellite-hub/README.md',
    'docker/satellite-hub/build-image.sh',
  ].map(read).join('\n');
  assert.doesNotMatch(active, /SATELLITE_HUB_SOURCE(?:_REF)?|\.\.\/PSFN-Satellite-Hub/u);
  assert.match(active, /apps\/satellite-hub/u);

  const dockerIgnore = read('.dockerignore');
  assert.match(dockerIgnore, /^apps\/satellite-hub\/$/mu);
  assert.match(dockerIgnore, /^tools\/evals\/$/mu);
});
