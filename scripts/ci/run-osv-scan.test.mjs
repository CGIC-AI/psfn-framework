import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OSV_IMAGE,
  OSV_LOCKFILES,
  OSV_VERSION,
  buildOsvScanArgs,
  interpretOsvVersion,
  parseOsvArgs,
  runOsv,
} from './run-osv-scan.mjs';

// A programmable docker stub. Classifies each invocation by its argv so tests can
// drive the version-probe and lockfile-scan outcomes independently and assert
// exit-code propagation without a real container.
function stubDocker({
  version = { status: 0, stdout: `osv-scanner version: ${OSV_VERSION}\n` },
  scan = { status: 0 },
} = {}) {
  const calls = [];
  const runDocker = (args) => {
    calls.push(args);
    if (args.includes('--version')) return { stdout: '', ...version };
    return { stdout: '', ...scan };
  };
  return { runDocker, calls };
}

const scanCall = (calls) => calls.find((args) => args.includes(OSV_IMAGE) && !args.includes('--version'));
const allExist = () => true;

test('OSV_LOCKFILES names exactly the three committed lockfiles', () => {
  assert.deepEqual(OSV_LOCKFILES, [
    'package-lock.json',
    'admin-ui/package-lock.json',
    'companion-ui/package-lock.json',
  ]);
});

test('parseOsvArgs defaults to table format and reads an explicit format', () => {
  assert.deepEqual(parseOsvArgs([]), { format: 'table' });
  assert.deepEqual(parseOsvArgs(['--format=json']), { format: 'json' });
  assert.deepEqual(parseOsvArgs(['--format', 'sarif']), { format: 'sarif' });
});

test('parseOsvArgs rejects unknown flags and formats', () => {
  assert.throws(() => parseOsvArgs(['--nope']), /Unknown osv wrapper flag/);
  assert.throws(() => parseOsvArgs(['--format=xml']), /Unsupported osv format/);
  assert.throws(() => parseOsvArgs(['package-lock.json']), /Unknown osv wrapper flag/);
});

test('interpretOsvVersion pins the runtime version and fails closed on drift', () => {
  assert.equal(interpretOsvVersion(`osv-scanner version: ${OSV_VERSION}\n`), OSV_VERSION);
  assert.throws(() => interpretOsvVersion('osv-scanner version: 2.5.0'), /unexpected version/);
  assert.throws(() => interpretOsvVersion('osv-scanner version: 2.4.01'), /unexpected version/);
  assert.throws(() => interpretOsvVersion(''), /unexpected version/);
});

test('buildOsvScanArgs mounts the repo read-only and names every owned lockfile', () => {
  const args = buildOsvScanArgs({ format: 'table' });
  assert.ok(args.includes(OSV_IMAGE));
  assert.ok(args.some((arg) => arg.endsWith(':/repo:ro')));
  assert.ok(args.includes('--format=table'));
  assert.deepEqual(
    args.filter((arg) => arg.startsWith('--lockfile=')),
    [
      '--lockfile=/repo/package-lock.json',
      '--lockfile=/repo/admin-ui/package-lock.json',
      '--lockfile=/repo/companion-ui/package-lock.json',
    ],
  );
});

test('runOsv returns 0 for a clean scan of all three lockfiles', () => {
  const { runDocker, calls } = stubDocker();
  assert.equal(runOsv({ argv: [], runDocker, fileExists: allExist }), 0);
  const scan = scanCall(calls);
  assert.equal(scan.filter((arg) => arg.startsWith('--lockfile=')).length, 3);
});

test('runOsv fails closed on findings (exit 1) under table and json formats', () => {
  for (const format of ['--format=json', undefined]) {
    const { runDocker } = stubDocker({ scan: { status: 1 } });
    const argv = format ? [format] : [];
    assert.equal(runOsv({ argv, runDocker, fileExists: allExist }), 1);
  }
});

test('runOsv propagates a scanner/resolve error exit code (fail closed)', () => {
  const { runDocker } = stubDocker({ scan: { status: 127 } });
  assert.equal(runOsv({ argv: [], runDocker, fileExists: allExist }), 127);
});

test('runOsv fails closed when the pinned image reports the wrong version', () => {
  const { runDocker, calls } = stubDocker({ version: { status: 0, stdout: 'osv-scanner version: 2.5.0\n' } });
  assert.throws(() => runOsv({ argv: [], runDocker, fileExists: allExist }), /unexpected version/);
  assert.equal(scanCall(calls), undefined);
});

test('runOsv refuses to scan when the version probe itself fails', () => {
  const { runDocker, calls } = stubDocker({ version: { status: 3, stdout: '' } });
  assert.equal(runOsv({ argv: [], runDocker, fileExists: allExist }), 3);
  assert.equal(scanCall(calls), undefined);
});

test('runOsv fails closed on a missing lockfile and never probes or scans', () => {
  const { runDocker, calls } = stubDocker();
  const fileExists = (path) => path !== 'companion-ui/package-lock.json';
  assert.throws(
    () => runOsv({ argv: [], runDocker, fileExists }),
    /missing committed lockfile\(s\): companion-ui\/package-lock\.json/,
  );
  assert.equal(calls.length, 0);
});
