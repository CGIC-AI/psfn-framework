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

// Production ExternalName Postgres host must be explicitly configured
// (psfn-framework-mlwk.32): an empty externalName renders a service whose DNS
// never resolves. The committed placeholder must be a value the apiserver
// rejects (not a valid DNS-1123 subdomain) so an unconfigured overlay fails at
// apply time instead of deploying silently broken.
const dns1123Subdomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const externalPostgres = readFileSync(
  resolve(repoRoot, 'k8s/overlays/production/external-postgres.yaml'),
  'utf8',
);
const externalNameMatch = externalPostgres.match(/^\s*externalName:\s*(.*)$/m);
if (!externalNameMatch) {
  throw new Error('production external-postgres.yaml missing externalName field');
}
const externalName = externalNameMatch[1].trim().replace(/^["']|["']$/g, '');
if (externalName === '') {
  throw new Error('production external-postgres.yaml externalName must not be empty');
}
const isRealHost = dns1123Subdomain.test(externalName);
const isFailClosedPlaceholder = externalName === 'REPLACE_WITH_EXTERNAL_POSTGRES_HOST';
if (!isRealHost && !isFailClosedPlaceholder) {
  throw new Error(
    `production external-postgres.yaml externalName must be a DNS-1123 subdomain or the fail-closed placeholder, got: ${externalName}`,
  );
}
if (isFailClosedPlaceholder && dns1123Subdomain.test(externalName)) {
  throw new Error('fail-closed placeholder must not be a valid DNS-1123 subdomain');
}

console.log('Kubernetes manifest verification passed.');
