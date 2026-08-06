import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE_PATH = join(REPOSITORY_ROOT, 'scripts/check-todo-bead-links.mjs');

function baseline(overrides = {}) {
  return {
    schemaVersion: 1,
    entries: [],
    ...overrides,
  };
}

function baselineEntry(overrides = {}) {
  return {
    path: 'src/example.ts',
    line: 1,
    marker: 'TODO',
    excerpt: '// TODO: grandfathered while the owner file migrates',
    note: 'Grandfathered: the owning bead is created during the owner-file migration wave.',
    ...overrides,
  };
}

function makeFixture({ files = {}, todoBaseline } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'psfn-todo-bead-links-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(cwd, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  if (todoBaseline) {
    mkdirSync(join(cwd, 'config'), { recursive: true });
    writeFileSync(
      join(cwd, 'config/todo-comment-baseline.json'),
      `${JSON.stringify(todoBaseline, null, 2)}\n`,
    );
  }
  return cwd;
}

function readWrittenBaseline(cwd) {
  return JSON.parse(
    readFileSync(join(cwd, 'config/todo-comment-baseline.json'), 'utf8'),
  );
}

function runGate(cwd, args = []) {
  return spawnSync(process.execPath, [GATE_PATH, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('fails for a missing baseline before scanning', () => {
  const cwd = makeFixture({
    files: { 'src/example.ts': '// TODO: never scanned because preflight fails\n' },
  });

  const result = runGate(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing config\/todo-comment-baseline\.json/u);
  assert.doesNotMatch(result.stdout, /scanned/u);
});

test('passes when every marker names its bead', () => {
  const cwd = makeFixture({
    files: {
      'src/example.ts': [
        '// TODO(htm9.2-followup): linked to its bead',
        '/* FIXME(psfn-framework-8genb): also linked */',
        "const query = 'TODO'; // marker word inside a string literal is ignored",
        '',
      ].join('\n'),
      'admin-ui/src/widget.svelte': '<!-- HACK(bead-1): html comments are scanned too -->\n',
      'src/example.test.ts': '// TODO: test files are excluded entirely\n',
    },
    todoBaseline: baseline(),
  });

  const result = runGate(cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 marker\(s\) total, 3 with a bead ref/u);
  assert.match(result.stdout, /\[check-todo-bead-links\] PASS/u);
});

test('fails on a marker without a bead ref', () => {
  const cwd = makeFixture({
    files: { 'src/example.ts': '// TODO: no bead named here\n' },
    todoBaseline: baseline(),
  });

  const result = runGate(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 marker\(s\) without a bead ref and not baselined/u);
  assert.match(result.stderr, /src\/example\.ts:1 TODO/u);
});

test('fails on a bead ref that does not match the bead-id shape', () => {
  const cwd = makeFixture({
    files: { 'src/example.ts': '// TODO(Not A Bead): bad shape\n' },
    todoBaseline: baseline(),
  });

  const result = runGate(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without a bead ref/u);
});

test('passes with a baselined violation', () => {
  const cwd = makeFixture({
    files: { 'src/example.ts': '// TODO: grandfathered while the owner file migrates\n' },
    todoBaseline: baseline({ entries: [baselineEntry()] }),
  });

  const result = runGate(cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: every marker names its bead or is baselined \(1 baselined/u);
});

test('fails on a stale baseline entry', () => {
  const cwd = makeFixture({
    files: { 'src/example.ts': '// clean now\n' },
    todoBaseline: baseline({ entries: [baselineEntry()] }),
  });

  const result = runGate(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 stale baseline entries no longer present/u);
});

test('fails on a baseline entry with an empty note', () => {
  const cwd = makeFixture({
    files: { 'src/example.ts': '// TODO: grandfathered while the owner file migrates\n' },
    todoBaseline: baseline({ entries: [baselineEntry({ note: '  ' })] }),
  });

  const result = runGate(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /has an empty note/u);
});

test('fails on unsorted baseline entries', () => {
  const cwd = makeFixture({
    files: {
      'src/b.ts': '// TODO: second\n',
      'src/a.ts': '// TODO: first\n',
    },
    todoBaseline: baseline({
      entries: [
        baselineEntry({ path: 'src/b.ts', excerpt: '// TODO: second' }),
        baselineEntry({ path: 'src/a.ts', excerpt: '// TODO: first' }),
      ],
    }),
  });

  const result = runGate(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be sorted/u);
});

test('--update refuses when it would add entries', () => {
  const cwd = makeFixture({
    files: { 'src/example.ts': '// TODO: brand new violation\n' },
    todoBaseline: baseline(),
  });

  const result = runGate(cwd, ['--update']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to update the baseline because it would add entries/u);
  assert.deepEqual(readWrittenBaseline(cwd), baseline());
});

test('--update prunes stale entries and keeps surviving notes', () => {
  const files = {
    'src/kept.ts': '// TODO: still grandfathered\n',
  };
  const cwd = makeFixture({
    files,
    todoBaseline: baseline({
      entries: [
        baselineEntry({
          path: 'src/gone.ts',
          excerpt: '// TODO: removed marker',
          note: 'Grandfathered: stale entry that --update must drop.',
        }),
        baselineEntry({
          path: 'src/kept.ts',
          excerpt: '// TODO: still grandfathered',
          note: 'Grandfathered: kept entry retains this exact note.',
        }),
      ],
    }),
  });

  const result = runGate(cwd, ['--update']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pruned 1 stale entries/u);
  const written = readWrittenBaseline(cwd);
  assert.equal(written.entries.length, 1);
  assert.equal(written.entries[0].path, 'src/kept.ts');
  assert.equal(written.entries[0].note, 'Grandfathered: kept entry retains this exact note.');
});

test('--update creates an empty baseline when nothing violates', () => {
  const cwd = makeFixture({
    files: { 'src/example.ts': '// TODO(bead-1): linked\n' },
  });

  const result = runGate(cwd, ['--update']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(cwd, 'config/todo-comment-baseline.json')), true);
  assert.deepEqual(readWrittenBaseline(cwd), baseline());
});

test('--update refuses to create an initial baseline with unlinked markers', () => {
  const cwd = makeFixture({
    files: { 'src/example.ts': '// TODO: unlinked at initial creation\n' },
  });

  const result = runGate(cwd, ['--update']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to create the initial baseline/u);
  assert.equal(existsSync(join(cwd, 'config/todo-comment-baseline.json')), false);
});
