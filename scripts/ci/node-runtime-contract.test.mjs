import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeVersion = '24.19.0';
const nodeTypesVersion = '24.13.3';
const nodeImage = `node:${nodeVersion}-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03`;

function read(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

test('framework, UI builders, and CI share the exact Node 24 LTS standard', () => {
  const rootPackage = JSON.parse(read('package.json'));
  const companionPackage = JSON.parse(read('companion-ui/package.json'));
  const satellitePackage = JSON.parse(read('apps/satellite-hub/package.json'));
  const evalPackage = JSON.parse(read('tools/evals/package.json'));

  assert.equal(read('.node-version').trim(), nodeVersion);
  assert.match(read('.npmrc'), /^engine-strict=true$/mu);
  assert.equal(rootPackage.packageManager, 'npm@11.17.0');
  assert.equal(rootPackage.engines.node, `>=${nodeVersion} <25`);
  assert.equal(rootPackage.devDependencies['@types/node'], nodeTypesVersion);
  assert.equal(companionPackage.devDependencies['@types/node'], nodeTypesVersion);
  for (const importedPackage of [satellitePackage, evalPackage]) {
    assert.equal(importedPackage.packageManager, 'npm@11.17.0');
    assert.equal(importedPackage.engines.node, `>=${nodeVersion} <25`);
    assert.equal(importedPackage.devDependencies['@types/node'], nodeTypesVersion);
  }
  assert.equal(read('apps/satellite-hub/.node-version').trim(), nodeVersion);
  assert.equal(read('tools/evals/.node-version').trim(), nodeVersion);
  assert.match(read('mise.toml'), /node = "24\.19\.0"/u);
  assert.match(read('mise.toml'), /npm = "11\.17\.0"/u);
  assert.match(read('tsconfig.json'), /"target": "ES2024"/u);
  assert.match(read('tsup.config.ts'), /target: 'node24'/u);

  for (const dockerfile of [
    'docker/Dockerfile.agent',
    'docker/companion-ui/Dockerfile',
    'docker/satellite-hub/Dockerfile',
  ]) {
    assert.match(read(dockerfile), new RegExp(nodeImage.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }

  for (const workflow of [
    '.github/workflows/ci.yml',
    '.github/workflows/osv-scan.yml',
    '.github/workflows/pr-labels.yml',
    '.github/workflows/trivy-image.yml',
    '.github/workflows/zizmor-audit.yml',
  ]) {
    assert.match(read(workflow), new RegExp(nodeVersion.replaceAll('.', '\\.'), 'u'));
  }
});

test('active runtime and operator docs do not retain the Node 22 split', () => {
  const activeSurfaces = [
    'README.md',
    'docs/setup.md',
    'docs/operations.md',
    'scripts/ci/check-local-tools.mjs',
  ].map(read).join('\n');

  assert.match(activeSurfaces, /Node(?:\.js)? 24/u);
  assert.doesNotMatch(activeSurfaces, /Node(?:\.js)? 22|node:22|node22|24\.13\.1|22\.22\.2/u);
});
