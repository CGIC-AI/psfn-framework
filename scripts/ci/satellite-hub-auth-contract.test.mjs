import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseAllDocuments } from 'yaml';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const baseArgs = ['template', 'hub-auth', 'deploy/helm/psfn',
  '--set', 'secrets.allowMissingRequired=true',
  '--set', 'satelliteHub.enabled=true',
  '--set', 'satelliteHub.image.repository=example.invalid/hub',
  '--set', 'satelliteHub.image.tag=test-pinned',
  '--set', 'satelliteHub.textOnly=true',
  '--set', 'satelliteHub.identity.satelliteId=hub',
  '--set', 'satelliteHub.identity.endpointId=hub',
  '--set', 'satelliteHub.identity.claimType=text-only'];

function render(overrides = []) {
  return spawnSync('helm', [...baseArgs, ...overrides.flatMap(value => ['--set', value])], {
    cwd: repoRoot, encoding: 'utf8',
  });
}

test('exposed Hub Helm rendering rejects missing caller authority even in test secret mode', () => {
  const result = render();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Satellite Hub requires.*device registry.*Voxta/);
});

test('dedicated Voxta authority renders as a Secret reference with developer access disabled', () => {
  const result = render(['satelliteHub.voxta.enabled=true',
    'satelliteHub.voxta.authTokenSecretRef.name=hub-voxta',
    'satelliteHub.voxta.authTokenSecretRef.key=VOXTA_AUTH_TOKEN',
    'satelliteHub.allowedOrigins[0]=https://client.example.test']);
  assert.equal(result.status, 0, result.stderr);
  const objects = parseAllDocuments(result.stdout).map(document => document.toJSON());
  const deployment = objects.find(object => object?.kind === 'Deployment'
    && object.spec.template.spec.containers.some(container => container.name === 'satellite-hub'));
  assert.ok(deployment);
  const env = deployment.spec.template.spec.containers.find(container => container.name === 'satellite-hub').env;
  assert.deepEqual(env.find(value => value.name === 'VOXTA_AUTH_TOKEN').valueFrom.secretKeyRef,
    { name: 'hub-voxta', key: 'VOXTA_AUTH_TOKEN' });
  assert.equal(env.find(value => value.name === 'VOXTA_FACADE_ENABLED').value, 'true');
  assert.equal(env.find(value => value.name === 'HUB_DEVELOPER_MODE').value, 'false');
  assert.equal(env.find(value => value.name === 'HUB_ALLOWED_ORIGINS').value, 'https://client.example.test');
});
