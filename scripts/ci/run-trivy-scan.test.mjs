import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  TRIVY_FLEET_HELM_RENDER_ARGS,
  TRIVY_HELM_RENDER_ARGS,
  TRIVY_HELM_RENDER_PASSES,
  TRIVY_IMAGE,
  TRIVY_VERSION,
  assertIgnoresNotExpired,
  buildTrivyConfigArgs,
  buildTrivyImageArgs,
  interpretTrivyVersion,
  parseTrivyArgs,
  parseTrivyIgnoreEntries,
  runTrivy,
} from './run-trivy-scan.mjs';

// A programmable docker stub. Classifies each invocation by argv so tests can
// drive the version probe and scan outcomes independently and assert exit-code
// propagation without a real container.
function stubDocker({
  version = { status: 0, stdout: `Version: ${TRIVY_VERSION}\n` },
  scan = { status: 0 },
  // Optional per-scan-call outcomes; overrides `scan` when provided so a test
  // can make (say) only the second config render pass report findings.
  scans = null,
} = {}) {
  const calls = [];
  let scanIndex = 0;
  const runDocker = (args) => {
    calls.push(args);
    if (args.includes('--version')) return { stdout: '', ...version };
    const outcome = scans ? (scans[scanIndex] ?? scans[scans.length - 1]) : scan;
    scanIndex += 1;
    return { stdout: '', ...outcome };
  };
  return { runDocker, calls };
}

const scanCall = (calls) => calls.find((args) => args.includes(TRIVY_IMAGE) && !args.includes('--version'));
const scanCalls = (calls) => calls.filter((args) => args.includes(TRIVY_IMAGE) && !args.includes('--version'));

// A helm render stub that materialises the per-template directory the scanner
// expects, so runTrivy's fail-closed "no templates" guard passes. Records the
// render args of each pass so tests can assert every topology is covered.
function stubHelmRender() {
  const renders = [];
  const render = (outDir, args = []) => {
    renders.push(args);
    const dir = join(outDir, 'psfn', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workloads.yaml'), 'kind: Deployment\n');
  };
  render.renders = renders;
  return render;
}

const FUTURE_IGNORE = `
misconfigurations:
  - id: AVD-KSV-0014
    paths: ["psfn/templates/postgres.yaml"]
    statement: postgres writable root
    expiry: 2999-01-01T00:00:00Z
`;

test('parseTrivyArgs requires a valid mode', () => {
  assert.throws(() => parseTrivyArgs([]), /requires a mode/);
  assert.throws(() => parseTrivyArgs(['audit']), /requires a mode/);
  assert.equal(parseTrivyArgs(['config']).mode, 'config');
});

test('parseTrivyArgs image mode demands exactly one exact target', () => {
  assert.throws(() => parseTrivyArgs(['image']), /requires --input .* or --image/);
  assert.throws(
    () => parseTrivyArgs(['image', '--input', 'a.tar', '--image', 'r@sha256:' + 'a'.repeat(64)]),
    /exactly one of --input or --image/,
  );
  assert.throws(() => parseTrivyArgs(['image', '--image', 'alpine:3.19']), /exact digest ref/);
  assert.throws(() => parseTrivyArgs(['image', '--image', 'alpine@sha256:abc']), /exact digest ref/);
  const ok = parseTrivyArgs(['image', '--image', `registry/repo@sha256:${'a'.repeat(64)}`]);
  assert.equal(ok.image, `registry/repo@sha256:${'a'.repeat(64)}`);
  assert.equal(parseTrivyArgs(['image', '--input', 'x.tar']).input, 'x.tar');
});

test('parseTrivyArgs rejects unknown flags', () => {
  assert.throws(() => parseTrivyArgs(['config', '--nope']), /Unknown trivy wrapper flag/);
});

test('interpretTrivyVersion pins the runtime version and fails closed on drift', () => {
  assert.equal(interpretTrivyVersion(`Version: ${TRIVY_VERSION}\n`), TRIVY_VERSION);
  assert.throws(() => interpretTrivyVersion('Version: 0.73.0'), /unexpected version/);
  assert.throws(() => interpretTrivyVersion('Version: 0.72.01'), /unexpected version/);
  assert.throws(() => interpretTrivyVersion(''), /unexpected version/);
});

test('assertIgnoresNotExpired accepts an exact future entry', () => {
  assert.equal(assertIgnoresNotExpired(FUTURE_IGNORE, new Date('2026-07-22T00:00:00Z')), 1);
});

test('assertIgnoresNotExpired fails closed on an expired entry', () => {
  const past = FUTURE_IGNORE.replace('2999-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
  assert.throws(() => assertIgnoresNotExpired(past, new Date('2026-07-22T00:00:00Z')), /expired exception/);
});

test('assertIgnoresNotExpired fails closed on a missing or malformed expiry', () => {
  const noExpiry = `
misconfigurations:
  - id: AVD-KSV-0014
    paths: ["psfn/templates/postgres.yaml"]
`;
  assert.throws(() => assertIgnoresNotExpired(noExpiry), /missing a required expiry/);
  const badDate = FUTURE_IGNORE.replace('2999-01-01T00:00:00Z', 'someday');
  assert.throws(() => assertIgnoresNotExpired(badDate), /unparseable expiry/);
});

test('assertIgnoresNotExpired forbids unscoped (pathless) entries and empty contracts', () => {
  const noPaths = `
misconfigurations:
  - id: AVD-KSV-0014
    expiry: 2999-01-01T00:00:00Z
`;
  assert.throws(() => assertIgnoresNotExpired(noPaths), /scoped to explicit paths/);
  assert.throws(() => assertIgnoresNotExpired('misconfigurations: []'), /at least one misconfigurations entry/);
  assert.throws(() => assertIgnoresNotExpired('nothing: here'), /at least one misconfigurations entry/);
});

test('parseTrivyIgnoreEntries parses the committed multi-entry ignore shape', () => {
  const text = `
misconfigurations:
  - id: AVD-KSV-0014
    paths:
      - "psfn/templates/postgres.yaml"
    statement: >-
      a multi-line
      block scalar with a colon: not a key
    expiry: 2999-01-01T00:00:00Z
  - id: AVD-KSV-0014
    paths:
      - "psfn/templates/redis.yaml"
    statement: single line
    expiry: 2999-02-02T00:00:00Z
`;
  const entries = parseTrivyIgnoreEntries(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { id: 'AVD-KSV-0014', paths: ['psfn/templates/postgres.yaml'], expiry: '2999-01-01T00:00:00Z' });
  assert.deepEqual(entries[1].paths, ['psfn/templates/redis.yaml']);
});

test('buildTrivyConfigArgs selects misconfig scanners, HIGH,CRITICAL, exit 1, and the ignore file', () => {
  const args = buildTrivyConfigArgs({ scanMount: '/render', ignoreMount: '/repo/.trivyignore.yaml' });
  assert.ok(args.includes('config'));
  assert.ok(args.includes(TRIVY_IMAGE));
  assert.deepEqual(
    args.slice(args.indexOf('--severity'), args.indexOf('--severity') + 2),
    ['--severity', 'HIGH,CRITICAL'],
  );
  assert.ok(args.includes('--misconfig-scanners'));
  assert.ok(args.includes('kubernetes,helm,dockerfile'));
  assert.deepEqual(args.slice(args.indexOf('--exit-code'), args.indexOf('--exit-code') + 2), ['--exit-code', '1']);
  assert.ok(args.includes('--disable-telemetry'));
  assert.ok(args.includes('--skip-version-check'));
  assert.ok(args.some((a) => a.endsWith(':/scan:ro')));
  assert.ok(args.some((a) => a.includes('.trivyignore.yaml:ro')));
});

test('buildTrivyImageArgs archive mode mounts the tar read-only and never mounts the Docker socket', () => {
  const args = buildTrivyImageArgs({ input: '/tmp/image.tar' });
  assert.ok(args.includes('image'));
  assert.ok(args.includes('--input'));
  assert.ok(args.some((a) => a === '/tmp/image.tar:/scan/image.tar:ro'));
  assert.ok(!args.some((a) => a.includes('docker.sock')));
  assert.deepEqual(args.slice(args.indexOf('--severity'), args.indexOf('--severity') + 2), ['--severity', 'HIGH,CRITICAL']);
  assert.deepEqual(args.slice(args.indexOf('--exit-code'), args.indexOf('--exit-code') + 2), ['--exit-code', '1']);
});

test('buildTrivyImageArgs digest mode scans the exact ref offline with no socket', () => {
  const ref = `registry/repo@sha256:${'a'.repeat(64)}`;
  const args = buildTrivyImageArgs({ image: ref });
  assert.ok(args.includes('--offline-scan'));
  assert.equal(args.at(-1), ref);
  assert.ok(!args.some((a) => a.includes('docker.sock')));
  assert.ok(!args.some((a) => a.includes(':/var/run')));
});

test('runTrivy config returns 0 for a clean render/scan', () => {
  const { runDocker, calls } = stubDocker();
  const status = runTrivy({
    argv: ['config'],
    runDocker,
    helmRender: stubHelmRender(),
    readIgnore: () => FUTURE_IGNORE,
    now: new Date('2026-07-22T00:00:00Z'),
  });
  assert.equal(status, 0);
  const scan = scanCall(calls);
  assert.ok(scan.includes('config'));
});

test('TRIVY_HELM_RENDER_PASSES covers both the non-fleet and the default fleet topology', () => {
  assert.deepEqual(TRIVY_HELM_RENDER_PASSES.map((pass) => pass.name), ['non-fleet', 'fleet']);
  const nonFleet = TRIVY_HELM_RENDER_PASSES.find((pass) => pass.name === 'non-fleet');
  const fleet = TRIVY_HELM_RENDER_PASSES.find((pass) => pass.name === 'fleet');
  assert.equal(nonFleet.args, TRIVY_HELM_RENDER_ARGS);
  assert.equal(fleet.args, TRIVY_FLEET_HELM_RENDER_ARGS);
  // The non-fleet pass explicitly disables fleet; the fleet pass enables it
  // (with its required fleetAuth and /runtime-derived paths) so fleet-agents.yaml
  // — the DEFAULT shipped container — is actually rendered and scanned.
  assert.ok(nonFleet.args.includes('fleet.enabled=false'));
  assert.ok(fleet.args.includes('fleet.enabled=true'));
  assert.ok(fleet.args.includes('fleetAuth.enabled=true'));
  assert.ok(fleet.args.includes('runtime.systemDataDir=/runtime/system-data'));
});

test('runTrivy config renders and scans every topology pass', () => {
  const { runDocker, calls } = stubDocker();
  const helmRender = stubHelmRender();
  const status = runTrivy({
    argv: ['config'],
    runDocker,
    helmRender,
    readIgnore: () => FUTURE_IGNORE,
    now: new Date('2026-07-22T00:00:00Z'),
  });
  assert.equal(status, 0);
  // One render + one scan per declared pass.
  assert.equal(helmRender.renders.length, TRIVY_HELM_RENDER_PASSES.length);
  assert.equal(scanCalls(calls).length, TRIVY_HELM_RENDER_PASSES.length);
  assert.ok(helmRender.renders.some((args) => args.includes('fleet.enabled=false')));
  assert.ok(helmRender.renders.some((args) => args.includes('fleet.enabled=true')));
});

test('runTrivy config fails closed when only the fleet render pass reports findings', () => {
  // First (non-fleet) scan clean, second (fleet) scan reports a finding.
  const { runDocker, calls } = stubDocker({ scans: [{ status: 0 }, { status: 1 }] });
  const status = runTrivy({
    argv: ['config'],
    runDocker,
    helmRender: stubHelmRender(),
    readIgnore: () => FUTURE_IGNORE,
    now: new Date('2026-07-22T00:00:00Z'),
  });
  assert.equal(status, 1);
  // Both passes are exercised (the gate does not short-circuit before fleet).
  assert.equal(scanCalls(calls).length, 2);
});

test('runTrivy config fails closed (exit 1) when the scan reports findings', () => {
  const { runDocker } = stubDocker({ scan: { status: 1 } });
  const status = runTrivy({
    argv: ['config'],
    runDocker,
    helmRender: stubHelmRender(),
    readIgnore: () => FUTURE_IGNORE,
    now: new Date('2026-07-22T00:00:00Z'),
  });
  assert.equal(status, 1);
});

test('runTrivy config refuses to render/scan when an ignore entry has expired', () => {
  const { runDocker, calls } = stubDocker();
  const past = FUTURE_IGNORE.replace('2999-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
  assert.throws(
    () => runTrivy({
      argv: ['config'],
      runDocker,
      helmRender: stubHelmRender(),
      readIgnore: () => past,
      now: new Date('2026-07-22T00:00:00Z'),
    }),
    /expired exception/,
  );
  // The version probe may run, but no config scan is ever dispatched.
  assert.equal(scanCall(calls), undefined);
});

test('runTrivy config fails closed when Helm render fails', () => {
  const { runDocker } = stubDocker();
  assert.throws(
    () => runTrivy({
      argv: ['config'],
      runDocker,
      helmRender: () => { throw new Error('Helm render failed; refusing to scan: boom'); },
      readIgnore: () => FUTURE_IGNORE,
      now: new Date('2026-07-22T00:00:00Z'),
    }),
    /Helm render failed/,
  );
});

test('runTrivy fails closed when the pinned image reports the wrong version', () => {
  const { runDocker, calls } = stubDocker({ version: { status: 0, stdout: 'Version: 0.73.0\n' } });
  assert.throws(
    () => runTrivy({ argv: ['image', '--input', 'x.tar'], runDocker }),
    /unexpected version/,
  );
  assert.equal(scanCall(calls), undefined);
});

test('runTrivy refuses to scan when the version probe itself fails', () => {
  const { runDocker, calls } = stubDocker({ version: { status: 3, stdout: '' } });
  assert.equal(runTrivy({ argv: ['image', '--input', 'x.tar'], runDocker }), 3);
  assert.equal(scanCall(calls), undefined);
});

test('runTrivy image propagates the scan exit code for archive and digest targets', () => {
  for (const argv of [['image', '--input', 'x.tar'], ['image', '--image', `r@sha256:${'a'.repeat(64)}`]]) {
    const { runDocker } = stubDocker({ scan: { status: 1 } });
    assert.equal(runTrivy({ argv, runDocker }), 1);
  }
});
