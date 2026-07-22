import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIONLINT_IMAGE,
  ZIZMOR_IMAGE,
  ZIZMOR_VERSION,
  buildActionlintArgs,
  buildZizmorScanArgs,
  discoverZizmorInputs,
  interpretZizmorVersion,
  parseZizmorArgs,
  runZizmor,
  validateZizmorInputs,
} from './run-zizmor-changed.mjs';

// A programmable docker stub. Classifies each invocation by its argv so tests
// can drive version-probe / actionlint / zizmor-scan outcomes independently and
// assert exit-code propagation without a real container.
function stubDocker({ version = { status: 0, stdout: `zizmor ${ZIZMOR_VERSION}\n` }, actionlint = { status: 0 }, scan = { status: 0 } } = {}) {
  const calls = [];
  const runDocker = (args) => {
    calls.push(args);
    if (args.includes('--version')) return { stdout: '', ...version };
    if (args.includes(ACTIONLINT_IMAGE)) return { stdout: '', ...actionlint };
    return { stdout: '', ...scan };
  };
  return { runDocker, calls };
}

const scanCall = (calls) =>
  calls.find((args) => args.includes(ZIZMOR_IMAGE) && !args.includes('--version'));

test('validateZizmorInputs accepts only explicit owned inputs and dedupes', () => {
  assert.deepEqual(
    validateZizmorInputs([
      '.github/workflows/ci.yml',
      '.github/workflows/ci.yml',
      '.github/actions/build/action.yml',
      '.github/dependabot.yml',
    ]),
    ['.github/actions/build/action.yml', '.github/dependabot.yml', '.github/workflows/ci.yml'],
  );
  assert.throws(() => validateZizmorInputs([]), /at least one input/);
  assert.throws(() => validateZizmorInputs(['src/index.ts']), /unexpected zizmor input/);
  assert.throws(() => validateZizmorInputs(['.github/README.md']), /unexpected zizmor input/);
});

test('discoverZizmorInputs filters a changed-file list without throwing on empty', () => {
  assert.deepEqual(
    discoverZizmorInputs([
      'src/core/session/manager.ts',
      '.github/workflows/ci.yaml',
      '.github/actions/setup/action.yml',
      '.github/dependabot.yml',
      '.github/labels.json',
      '.github/workflows/ci.yaml',
    ]),
    ['.github/actions/setup/action.yml', '.github/dependabot.yml', '.github/workflows/ci.yaml'],
  );
  assert.deepEqual(discoverZizmorInputs(['src/index.ts', 'README.md']), []);
});

test('parseZizmorArgs defaults changed mode to offline plain scan of explicit paths', () => {
  assert.deepEqual(parseZizmorArgs(['.github/workflows/ci.yml']), {
    mode: 'changed',
    format: 'plain',
    base: '',
    head: '',
    paths: ['.github/workflows/ci.yml'],
  });
});

test('parseZizmorArgs reads format and discovery range flags', () => {
  assert.deepEqual(parseZizmorArgs(['--format=github', '--base', 'aaa', '--head=bbb']), {
    mode: 'changed',
    format: 'github',
    base: 'aaa',
    head: 'bbb',
    paths: [],
  });
});

test('parseZizmorArgs defaults audit mode to github format', () => {
  assert.deepEqual(parseZizmorArgs(['audit']), {
    mode: 'audit',
    format: 'github',
    base: '',
    head: '',
    paths: [],
  });
  assert.equal(parseZizmorArgs(['audit', '--format=sarif']).format, 'sarif');
});

test('parseZizmorArgs rejects unknown flags and formats', () => {
  assert.throws(() => parseZizmorArgs(['--nope']), /Unknown zizmor wrapper flag/);
  assert.throws(() => parseZizmorArgs(['--format=xml']), /Unsupported zizmor format/);
});

test('interpretZizmorVersion pins the runtime version and fails closed on drift', () => {
  assert.equal(interpretZizmorVersion(`zizmor ${ZIZMOR_VERSION}\n`), ZIZMOR_VERSION);
  assert.throws(() => interpretZizmorVersion('zizmor main'), /unexpected version/);
  assert.throws(() => interpretZizmorVersion('zizmor 1.27.01'), /unexpected version/);
  assert.throws(() => interpretZizmorVersion(''), /unexpected version/);
});

test('buildZizmorScanArgs changed mode is offline, strict, regular persona, plain-safe', () => {
  const args = buildZizmorScanArgs({
    mode: 'changed',
    format: 'github',
    paths: ['.github/workflows/ci.yml'],
  });
  assert.ok(args.includes('--offline'));
  assert.ok(args.includes('--strict-collection'));
  assert.ok(args.includes('--persona=regular'));
  assert.ok(args.includes('--format=github'));
  assert.ok(args.at(-1) === '.github/workflows/ci.yml');
  assert.ok(args.includes(ZIZMOR_IMAGE));
  assert.ok(!args.includes('--env')); // changed scan needs no GitHub token
});

test('buildZizmorScanArgs audit mode is online with a read-only token and full collection', () => {
  const args = buildZizmorScanArgs({ mode: 'audit', format: 'github' });
  assert.ok(!args.includes('--offline')); // online audits must be able to run
  assert.ok(args.includes('--persona=regular')); // no pedantic/auditor blocking default
  assert.ok(!args.includes('--strict-collection'));
  assert.deepEqual(args.slice(-4), ['--persona=regular', '--format=github', '--color=never', '.']);
  const tokenIndex = args.indexOf('--env');
  assert.equal(args[tokenIndex + 1], 'GH_TOKEN');
});

test('buildActionlintArgs mounts the repo read-only and passes workflow paths', () => {
  const args = buildActionlintArgs(['.github/workflows/ci.yml']);
  assert.ok(args.includes(ACTIONLINT_IMAGE));
  assert.ok(args.some((arg) => arg.endsWith(':/repo:ro')));
  assert.equal(args.at(-1), '.github/workflows/ci.yml');
});

test('runZizmor returns 0 for a clean explicit workflow scan', () => {
  const { runDocker, calls } = stubDocker();
  assert.equal(runZizmor({ argv: ['.github/workflows/ci.yml'], runDocker }), 0);
  assert.ok(scanCall(calls));
});

test('runZizmor propagates a findings exit code (github format is enforcing)', () => {
  // zizmor exits 14 on findings under --format=github; the gate must fail.
  const { runDocker } = stubDocker({ scan: { status: 14 } });
  assert.equal(runZizmor({ argv: ['--format=github', '.github/workflows/ci.yml'], runDocker }), 14);
});

test('runZizmor propagates a malformed-input failure (fail closed)', () => {
  // zizmor exits 1 when a collected input cannot be loaded/parsed.
  const { runDocker } = stubDocker({ scan: { status: 1 } });
  assert.equal(runZizmor({ argv: ['.github/workflows/broken.yml'], runDocker }), 1);
});

test('runZizmor propagates a scanner crash exit code', () => {
  const { runDocker } = stubDocker({ scan: { status: 125 } });
  assert.equal(runZizmor({ argv: ['.github/workflows/ci.yml'], runDocker }), 125);
});

test('runZizmor refuses an explicit scan with no inputs', () => {
  const { runDocker } = stubDocker();
  assert.throws(() => runZizmor({ argv: [], runDocker }), /explicit paths or both --base and --head/);
});

test('runZizmor no-ops (exit 0) when discovery finds no owned changes and never scans', () => {
  const { runDocker, calls } = stubDocker();
  const runGit = () => 'src/core/session/manager.ts\nREADME.md\n';
  assert.equal(runZizmor({ argv: ['--format=github', '--base', 'a', '--head', 'b'], runDocker, runGit }), 0);
  assert.equal(scanCall(calls), undefined);
});

test('runZizmor discovers and scans owned changes from a diff range', () => {
  const { runDocker, calls } = stubDocker();
  const runGit = () => '.github/workflows/ci.yml\nsrc/index.ts\n.github/dependabot.yml\n';
  assert.equal(runZizmor({ argv: ['--format=github', '--base', 'a', '--head', 'b'], runDocker, runGit }), 0);
  const scan = scanCall(calls);
  assert.deepEqual(scan.slice(-2), ['.github/dependabot.yml', '.github/workflows/ci.yml']);
});

test('runZizmor fails closed when the pinned image reports the wrong version', () => {
  const { runDocker } = stubDocker({ version: { status: 0, stdout: 'zizmor main\n' } });
  assert.throws(
    () => runZizmor({ argv: ['.github/workflows/ci.yml'], runDocker }),
    /unexpected version/,
  );
});

test('runZizmor refuses to scan when the version probe itself fails', () => {
  const { runDocker, calls } = stubDocker({ version: { status: 3, stdout: '' } });
  assert.equal(runZizmor({ argv: ['.github/workflows/ci.yml'], runDocker }), 3);
  assert.equal(scanCall(calls), undefined);
});

test('runZizmor short-circuits on an actionlint failure before running zizmor', () => {
  const { runDocker, calls } = stubDocker({ actionlint: { status: 1 } });
  assert.equal(runZizmor({ argv: ['.github/workflows/ci.yml'], runDocker }), 1);
  assert.equal(scanCall(calls), undefined);
});

test('runZizmor skips actionlint for non-workflow inputs but still runs zizmor', () => {
  const { runDocker, calls } = stubDocker();
  assert.equal(runZizmor({ argv: ['.github/dependabot.yml'], runDocker }), 0);
  assert.equal(calls.some((args) => args.includes(ACTIONLINT_IMAGE)), false);
  assert.ok(scanCall(calls));
});

test('runZizmor runs the online audit and returns its exit code', () => {
  const { runDocker, calls } = stubDocker({ scan: { status: 0 } });
  assert.equal(runZizmor({ argv: ['audit'], runDocker }), 0);
  const audit = scanCall(calls);
  assert.ok(audit.includes('--env'));
  assert.ok(!audit.includes('--offline'));
});
