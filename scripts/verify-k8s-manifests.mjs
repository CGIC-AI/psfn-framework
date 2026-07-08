#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function kustomizeBuild(relativeDir) {
  return execFileSync('kubectl', ['kustomize', resolve(repoRoot, relativeDir)], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} missing: ${needle}`);
  }
}

function assertNotIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`${label} unexpectedly contains: ${needle}`);
  }
}

for (const target of ['k8s/base', 'k8s/overlays/dev', 'k8s/overlays/production']) {
  const rendered = kustomizeBuild(target);

  // No deployable database credential may ship in committed manifests
  // (psfn-framework-mlwk.31): the DSN must stay an empty placeholder that is
  // injected from environment-specific secret management at deploy time.
  assertNotIncludes(rendered, ':changeme@', `${target} committed weak DSN`);
  assertNotIncludes(rendered, 'postgresql://psfn:', `${target} committed DSN credential`);
  assertIncludes(rendered, 'POSTGRES_DATABASE_URL: ""', `${target} empty DSN placeholder`);
}

console.log('Kubernetes manifest verification passed.');
