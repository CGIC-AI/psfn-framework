#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = resolve(repoRoot, 'deploy/helm/psfn');

function render(args = []) {
  return execFileSync('helm', [
    'template',
    'psfn',
    chartDir,
    '--namespace',
    'psfn-test',
    ...args,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function assertRenderFails(args, expectedMessage) {
  try {
    render(args);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assertIncludes(output, expectedMessage, 'Helm validation failure');
    return;
  }

  throw new Error(`Helm render unexpectedly succeeded: ${args.join(' ')}`);
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

function documents(rendered) {
  return rendered
    .split(/^---$/m)
    .map(doc => doc.trim())
    .filter(Boolean);
}

function findDocument(rendered, name) {
  return documents(rendered).find(doc => doc.includes(`\n  name: ${name}\n`)) ?? '';
}

const rendered = render();

for (const spiffe of [
  'spiffe://cluster.local/psfn/gateway/companion',
  'spiffe://cluster.local/psfn/agent/companion',
  'spiffe://cluster.local/psfn/garden/companion',
]) {
  assertIncludes(rendered, spiffe, 'SPIFFE URI SAN contract');
}

for (const envName of [
  'SYSTEM_DATA_DIR',
  'COMPANION_DATA_DIR',
  'WORKSPACE_PATH',
  'POSTGRES_DATABASE_URL',
  'PSFN_REDIS_URL',
  'GATEWAY_RPC_ENDPOINT',
  'ADMIN_TRANSPORT_URL',
]) {
  assertIncludes(rendered, `- name: ${envName}`, 'runtime env contract');
}

assertIncludes(rendered, 'mountPath: /app/system-data', 'system-data PVC mount');
assertIncludes(rendered, 'mountPath: /app/companion-data', 'companion-data PVC mount');
assertIncludes(rendered, 'mountPath: /app/workspace', 'workspace PVC mount');
assertIncludes(rendered, 'mountPath: /app/models/transformers', 'model cache PVC mount');
assertIncludes(rendered, 'CREATE EXTENSION IF NOT EXISTS vector;', 'pgvector init SQL');
assertIncludes(rendered, 'kind: NetworkPolicy', 'network policy render');
assertNotIncludes(rendered, 'ALLOW_AGENT_OUTBOUND_NETWORK', 'agent network isolation');

const appSecret = findDocument(rendered, 'psfn-app');
assertIncludes(appSecret, 'kind: Secret', 'app secret kind');
assertIncludes(appSecret, 'API_KEY:', 'API key secret');
assertIncludes(appSecret, 'ADMIN_TOKEN:', 'admin token secret');
assertIncludes(appSecret, 'GATEWAY_SESSION_HMAC_KEY:', 'session HMAC secret');

const defaultDenyPolicy = findDocument(rendered, 'psfn-default-deny');
assertIncludes(defaultDenyPolicy, 'podSelector: {}', 'default deny policy');
assertIncludes(defaultDenyPolicy, '- Ingress', 'default deny ingress');
assertIncludes(defaultDenyPolicy, '- Egress', 'default deny egress');

const agentPolicy = findDocument(rendered, 'psfn-agent');
assertNotIncludes(agentPolicy, '0.0.0.0/0', 'agent policy broad egress');
assertIncludes(agentPolicy, 'component: gateway', 'agent policy gateway flow');
assertIncludes(agentPolicy, 'component: postgres', 'agent policy postgres flow');
assertIncludes(agentPolicy, 'component: redis', 'agent policy redis flow');

const externalRendered = render([
  '--set',
  'postgres.enabled=false',
  '--set',
  'postgres.external.enabled=true',
  '--set',
  'postgres.external.databaseUrlSecret.name=external-pg',
  '--set',
  'redis.mode=external',
  '--set',
  'redis.external.url=redis://external-redis:6379',
  '--set',
  'redis.external.passwordSecret.name=external-redis-secret',
]);

assertIncludes(externalRendered, 'name: external-pg', 'external Postgres secret ref');
assertIncludes(externalRendered, 'value: "redis://external-redis:6379"', 'external Redis URL');
assertNotIncludes(externalRendered, 'name: psfn-postgres\n', 'bundled Postgres resources in external mode');
assertNotIncludes(externalRendered, 'name: psfn-redis\n', 'bundled Redis resources in external mode');

const hubRendered = render([
  '--set',
  'satelliteHub.enabled=true',
  '--set',
  'satelliteHub.image.repository=localhost/psfn-satellite-hub',
  '--set',
  'satelliteHub.image.tag=0.1.0-kube',
  '--set',
  'ingress.satelliteHub.enabled=true',
]);

assertIncludes(hubRendered, 'kind: Deployment\nmetadata:\n  name: psfn-satellite-hub', 'satellite hub Deployment');
assertIncludes(hubRendered, 'kind: Service\nmetadata:\n  name: psfn-satellite-hub', 'satellite hub Service');
assertIncludes(hubRendered, 'kind: Ingress\nmetadata:\n  name: psfn-satellite-hub', 'satellite hub Ingress');
assertIncludes(hubRendered, 'kind: NetworkPolicy\nmetadata:\n  name: psfn-satellite-hub', 'satellite hub NetworkPolicy');
assertIncludes(hubRendered, 'name: hub-ws', 'satellite hub websocket port');
assertIncludes(hubRendered, 'name: GATEWAY_API_URL', 'satellite hub gateway API wiring');

assertRenderFails(
  ['--set', 'certificates.enabled=false'],
  'certificates.enabled must be true',
);
assertRenderFails(
  ['--set', 'postgres.enabled=false'],
  'postgres.enabled=false requires postgres.external.enabled=true',
);
assertRenderFails(
  ['--set', 'redis.mode=external', '--set', 'redis.external.passwordSecret.name=external-redis-secret'],
  'redis.external.url is required when redis.mode=external',
);
assertRenderFails(
  ['--set', 'satelliteHub.enabled=true'],
  'satelliteHub.image.repository is required when satelliteHub.enabled=true',
);

console.log('Helm chart verification passed.');
