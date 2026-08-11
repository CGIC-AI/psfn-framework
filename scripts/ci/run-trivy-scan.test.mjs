import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRIVY_IMAGE,
  TRIVY_VERSION,
  buildTrivyImageArgs,
  interpretTrivyVersion,
  parseTrivyArgs,
  runTrivy,
} from './run-trivy-scan.mjs';

function stubDocker({
  version = { status: 0, stdout: `Version: ${TRIVY_VERSION}\n` },
  scan = { status: 0, stdout: '' },
} = {}) {
  const calls = [];
  const runDocker = (args) => {
    calls.push(args);
    return args.includes('--version') ? version : scan;
  };
  return { runDocker, calls };
}

test('accepts only image mode with exactly one immutable target', () => {
  assert.throws(() => parseTrivyArgs([]), /requires image mode/);
  assert.throws(() => parseTrivyArgs(['config']), /requires image mode/);
  assert.throws(() => parseTrivyArgs(['image']), /requires --input .* or --image/);
  assert.throws(
    () => parseTrivyArgs(['image', '--input', 'a.tar', '--image', `r@sha256:${'a'.repeat(64)}`]),
    /exactly one/,
  );
  assert.throws(() => parseTrivyArgs(['image', '--image', 'alpine:latest']), /exact digest ref/);
  assert.equal(parseTrivyArgs(['image', '--input', 'image.tar']).input, 'image.tar');
  assert.equal(
    parseTrivyArgs(['image', '--image', `registry.example/repo@sha256:${'a'.repeat(64)}`]).image,
    `registry.example/repo@sha256:${'a'.repeat(64)}`,
  );
});

test('rejects unknown flags', () => {
  assert.throws(() => parseTrivyArgs(['image', '--nope']), /Unknown trivy wrapper flag/);
});

test('pins the scanner version and rejects drift', () => {
  assert.equal(interpretTrivyVersion(`Version: ${TRIVY_VERSION}\n`), TRIVY_VERSION);
  assert.throws(() => interpretTrivyVersion('Version: 0.73.0'), /unexpected version/);
  assert.throws(() => interpretTrivyVersion('Version: 0.72.01'), /unexpected version/);
});

test('archive mode mounts only the archive read-only', () => {
  const args = buildTrivyImageArgs({ input: '/tmp/image.tar' });
  assert.ok(args.includes(TRIVY_IMAGE));
  assert.ok(args.includes('--input'));
  assert.ok(args.includes('/tmp/image.tar:/scan/image.tar:ro'));
  assert.ok(!args.some((arg) => arg.includes('docker.sock')));
  assert.deepEqual(args.slice(args.indexOf('--severity'), args.indexOf('--severity') + 2), [
    '--severity', 'HIGH,CRITICAL',
  ]);
});

test('digest mode requires and scans the exact ref without a socket', () => {
  const image = `registry.example/repo@sha256:${'a'.repeat(64)}`;
  const args = buildTrivyImageArgs({ image });
  assert.ok(args.includes('--offline-scan'));
  assert.equal(args.at(-1), image);
  assert.ok(!args.some((arg) => arg.includes('docker.sock')));
});

test('propagates scan failures after verifying the pinned image', () => {
  const { runDocker, calls } = stubDocker({ scan: { status: 1, stdout: '' } });
  assert.equal(runTrivy({ argv: ['image', '--input', 'image.tar'], runDocker }), 1);
  assert.equal(calls.length, 2);
});

test('fails closed when the version probe fails or drifts', () => {
  const failed = stubDocker({ version: { status: 3, stdout: '' } });
  assert.equal(runTrivy({ argv: ['image', '--input', 'image.tar'], runDocker: failed.runDocker }), 3);
  assert.equal(failed.calls.length, 1);

  const drifted = stubDocker({ version: { status: 0, stdout: 'Version: 0.73.0\n' } });
  assert.throws(
    () => runTrivy({ argv: ['image', '--input', 'image.tar'], runDocker: drifted.runDocker }),
    /unexpected version/,
  );
  assert.equal(drifted.calls.length, 1);
});
