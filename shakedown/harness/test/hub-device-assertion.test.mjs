import assert from 'node:assert/strict';
import test from 'node:test';

import { createFrameworkHubDeviceAssertionIssuer } from '../lib/hub-device-assertion.mjs';

test('framework assertion bridge invokes the canonical issuer without exposing key material', () => {
  const calls = [];
  const issue = createFrameworkHubDeviceAssertionIssuer({
    repoRoot: '/framework',
    env: {
      SYSTEM_DATA_DIR: '/runtime/system-data',
      HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH: '/run/private/assertion.pem',
      HUB_DEVICE_ASSERTION_TTL_SECONDS: '30',
    },
    execFile: (...args) => {
      calls.push(args);
      return 'header.claims.signature\n';
    },
  });

  assert.equal(issue({
    companionId: '11111111-1111-4111-8111-111111111111',
    satelliteId: 'office-satellite',
    endpointId: 'office-endpoint',
    sessionId: 'realtime:office-device:session',
  }), 'header.claims.signature');

  const [executable, args, options] = calls[0];
  assert.equal(executable, '/framework/node_modules/.bin/tsx');
  assert.deepEqual(args, ['/framework/scripts/ops/issue-hub-device-assertion.ts']);
  assert.deepEqual(JSON.parse(options.input), {
    fleetAuthPath: '/runtime/system-data/fleet-auth.json',
    satelliteRegistryPath: '/runtime/system-data/satellites.json',
    privateKeyPath: '/run/private/assertion.pem',
    ttlSeconds: 30,
    companionId: '11111111-1111-4111-8111-111111111111',
    satelliteId: 'office-satellite',
    endpointId: 'office-endpoint',
    sessionId: 'realtime:office-device:session',
  });
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(JSON.stringify(calls).includes('PRIVATE KEY'), false);
});

test('framework assertion bridge fails closed on partial authority or malformed output', () => {
  assert.throws(() => createFrameworkHubDeviceAssertionIssuer({
    repoRoot: '/framework',
    env: {
      SYSTEM_DATA_DIR: '/runtime/system-data',
    },
    execFile: () => '',
  }), /requires HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH/u);

  const issue = createFrameworkHubDeviceAssertionIssuer({
    repoRoot: '/framework',
    env: {
      SYSTEM_DATA_DIR: '/runtime/system-data',
      HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH: '/run/private/assertion.pem',
      HUB_DEVICE_ASSERTION_TTL_SECONDS: '30',
    },
    execFile: () => 'not-an-assertion\n',
  });
  assert.throws(() => issue({
    companionId: '11111111-1111-4111-8111-111111111111',
    satelliteId: 'office-satellite',
    endpointId: 'office-endpoint',
    sessionId: 'realtime:office-device:session',
  }), /canonical Hub device assertion issuer returned malformed output/u);
});
