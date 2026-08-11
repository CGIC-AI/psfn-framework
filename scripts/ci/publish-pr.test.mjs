import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { publishPr } from './publish-pr.mjs';

const HEAD = '1111111111111111111111111111111111111111';
const BASE = '2222222222222222222222222222222222222222';

function makePublisherFixture({
  existingPr,
  pushFails = false,
  reviewComments = '[]',
  metadataUpdateFails = false,
  labelUpdateFails = false,
  invalidLabel = '',
  createFails = false,
  readyFails = false,
  malformedPrPayload,
  expectedStatusActor = 'publisher',
  authenticatedActor = 'publisher',
}) {
  const calls = [];
  const gateCalls = [];
  const spawnCalls = [];
  const appliedLabels = [];
  const readyLabelSnapshots = [];
  let listCount = 0;

  function runCommand(executable, args) {
    calls.push([executable, ...args]);
    if (executable === 'git' && args[0] === 'config' && args.includes('core.hooksPath')) {
      return '.githooks';
    }
    if (executable === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
      return 'work/publish-ordering';
    }
    if (executable === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return HEAD;
    if (executable === 'git' && args[0] === 'ls-remote') {
      return `${HEAD}\trefs/heads/work/publish-ordering`;
    }
    if (executable === 'gh' && args[0] === 'variable') return expectedStatusActor;
    if (executable === 'gh' && args[0] === 'api' && args[1] === 'user') {
      return authenticatedActor;
    }
    if (
      executable === 'gh'
      && args[0] === 'api'
      && String(args[1]).startsWith('repos/{owner}/{repo}/labels/')
    ) {
      if (args[1] === `repos/{owner}/{repo}/labels/${encodeURIComponent(invalidLabel)}`) {
        throw new Error('HTTP 404: Not Found');
      }
      return '';
    }
    if (executable === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      listCount += 1;
      if (listCount === 1) {
        if (malformedPrPayload !== undefined) return malformedPrPayload;
        if (!existingPr) return '[]';
        return JSON.stringify([{
          number: 191,
          url: 'https://example.invalid/pr/191',
          isDraft: true,
        }]);
      }
      return JSON.stringify([{ number: 191, url: 'https://example.invalid/pr/191', isDraft: false }]);
    }
    if (executable === 'git' && (
      args[0] === 'fetch'
      || (args[0] === 'config' && args[1].startsWith('branch.'))
      || (args[0] === 'branch' && args[1] === '--set-upstream-to')
    )) return '';
    if (
      executable === 'gh'
      && args[0] === 'api'
      && args[1] === '--method'
      && args[2] === 'PATCH'
    ) {
      if (metadataUpdateFails) throw new Error('HTTP 403: resource not accessible');
      return '';
    }
    if (executable === 'gh' && args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') {
      if (labelUpdateFails && String(args[3]).endsWith('/labels')) {
        throw new Error('HTTP 422: validation failed');
      }
      if (String(args[3]).endsWith('/labels')) {
        appliedLabels.push(
          ...args
            .filter(argument => String(argument).startsWith('labels[]='))
            .map(argument => argument.slice('labels[]='.length)),
        );
      }
      return '';
    }
    if (executable === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--label') appliedLabels.push(args[index + 1]);
      }
      if (createFails) throw new Error('HTTP 502: label round-trip failed');
      return '';
    }
    if (executable === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
      readyLabelSnapshots.push([...appliedLabels]);
      if (readyFails) throw new Error('HTTP 502: ready transition failed');
      return '';
    }
    if (executable === 'gh' && args[0] === 'api' && String(args[1]).includes('/comments')) {
      return reviewComments;
    }
    throw new Error(`Unexpected mock command: ${executable} ${args.join(' ')}`);
  }

  function spawnCommand(executable, args, options) {
    calls.push([executable, ...args]);
    spawnCalls.push({ executable, args, options });
    if (executable !== 'git' || args[0] !== 'push') {
      throw new Error(`Unexpected mock spawn: ${executable} ${args.join(' ')}`);
    }
    return pushFails ? { error: undefined, status: 1 } : { error: undefined, status: 0 };
  }

  return {
    appliedLabels,
    calls,
    gateCalls,
    readyLabelSnapshots,
    spawnCalls,
    dependencies: {
      runCommand,
      spawnCommand,
      runGate: async (options) => {
        gateCalls.push({
          options,
          exception: process.env.CHANGE_BUDGET_EXCEPTION,
          body: process.env.CHANGE_BUDGET_PR_BODY,
          forceOffline: process.env.CHANGE_BUDGET_USE_OFFLINE,
        });
      },
      resolveGateState: () => ({
        head: HEAD,
        base: BASE,
        baseRef: 'origin/main',
        attestationPath: '/tmp/test-attestation.json',
      }),
      readGateAttestation: () => ({}),
      validateGateAttestation: () => ({ result: { valid: true, reason: '' } }),
      readBodyFile: (path) => path === 'pr-body.md'
        ? '## Change-budget exception\n\nDocumented test variance.\n'
        : readFileSync(path, 'utf8'),
      wait: async ({ reference, expectedHead }) => {
        calls.push(['wait', reference, expectedHead]);
      },
    },
  };
}

test('publisher updates only existing-PR title and body through REST before the exact-head push', async (t) => {
  const fixture = makePublisherFixture({ existingPr: true });
  const bodyDir = mkdtempSync(join(tmpdir(), 'publish-pr-body-'));
  const bodyFile = join(bodyDir, 'body.md');
  writeFileSync(bodyFile, 'Updated body\nwith detail.\n');
  t.after(() => rmSync(bodyDir, { recursive: true, force: true }));

  await publishPr(
    ['--title', 'Updated title', '--body-file', bodyFile],
    fixture.dependencies,
  );

  const updateIndex = fixture.calls.findIndex(
    ([executable, scope, method, verb]) =>
      executable === 'gh' && scope === 'api' && method === '--method' && verb === 'PATCH',
  );
  const pushIndex = fixture.calls.findIndex(
    ([executable, command]) => executable === 'git' && command === 'push',
  );
  assert.deepEqual(fixture.calls[updateIndex], [
    'gh',
    'api',
    '--method',
    'PATCH',
    'repos/{owner}/{repo}/pulls/191',
    '-f',
    'title=Updated title',
    '-f',
    'body=Updated body\nwith detail.\n',
  ]);
  assert.ok(updateIndex < pushIndex, 'metadata API failure must be knowable before push');
  assert.deepEqual(fixture.spawnCalls[0].args, [
    'push',
    'origin',
    `--force-with-lease=refs/heads/work/publish-ordering:${HEAD}`,
    `${HEAD}:refs/heads/work/publish-ordering`,
  ]);
  assert.equal(fixture.spawnCalls[0].options.env.PSFN_ATTESTED_PUBLISH, '1');
  assert.equal(
    fixture.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'edit'),
    false,
    'publisher must not invoke the Projects Classic-backed gh pr edit path',
  );
  assert.equal(
    fixture.calls.some(call => call[0] === 'wait'),
    false,
    'publishing returns after PR creation instead of consuming the implementation session',
  );
});

test('publisher waits for checks only with explicit --wait', async () => {
  const fixture = makePublisherFixture({ existingPr: true });

  await publishPr(['--wait'], fixture.dependencies);

  assert.deepEqual(fixture.calls.find(call => call[0] === 'wait'), ['wait', '191', HEAD]);
});

test('publisher stops before push when an existing-PR metadata API update fails', async (t) => {
  const fixture = makePublisherFixture({ existingPr: true, metadataUpdateFails: true });
  const bodyDir = mkdtempSync(join(tmpdir(), 'publish-pr-body-'));
  const bodyFile = join(bodyDir, 'body.md');
  writeFileSync(bodyFile, 'Updated body\n');
  t.after(() => rmSync(bodyDir, { recursive: true, force: true }));

  await assert.rejects(
    publishPr(['--title', 'Updated title', '--body-file', bodyFile], fixture.dependencies),
    /Failed to update metadata for PR #191 before push.*HTTP 403/s,
  );
  assert.equal(
    fixture.calls.some(([executable, command]) => executable === 'git' && command === 'push'),
    false,
  );
});

test('publisher fails before push on unauthorised or malformed existing-PR data', async () => {
  const unauthorized = makePublisherFixture({
    existingPr: true,
    expectedStatusActor: 'publisher',
    authenticatedActor: 'wrong-actor',
  });
  await assert.rejects(publishPr([], unauthorized.dependencies), /not the configured local-gate status issuer/);
  assert.equal(
    unauthorized.calls.some(([executable, command]) => executable === 'git' && command === 'push'),
    false,
  );

  const malformedPayloads = [
    '{',
    '{}',
    'null',
    JSON.stringify([{
      number: '191',
      url: 'https://example.invalid/pr/191',
      isDraft: true,
    }]),
  ];
  for (const malformedPrPayload of malformedPayloads) {
    const malformed = makePublisherFixture({ existingPr: true, malformedPrPayload });
    await assert.rejects(publishPr([], malformed.dependencies), /malformed PR data/);
    assert.equal(
      malformed.calls.some(([executable, command]) => executable === 'git' && command === 'push'),
      false,
    );
  }
});

test('publisher marks an existing draft PR ready before pushing the attested head', async () => {
  const fixture = makePublisherFixture({ existingPr: true });

  await publishPr([], fixture.dependencies);

  const readyIndex = fixture.calls.findIndex(
    ([executable, scope, command]) => executable === 'gh' && scope === 'pr' && command === 'ready',
  );
  const pushIndex = fixture.calls.findIndex(
    ([executable, command]) => executable === 'git' && command === 'push',
  );
  assert.ok(readyIndex >= 0, 'existing draft PR must be marked ready');
  assert.ok(readyIndex < pushIndex, 'draft PR must be ready before the attested head is pushed');
  assert.equal(
    fixture.calls.some(
      ([executable, scope, method, verb]) =>
        executable === 'gh' && scope === 'api' && method === '--method' && verb === 'PATCH',
    ),
    false,
    'runs without metadata arguments skip the metadata API entirely',
  );
});

test('publisher restores draft state when the push fails after marking ready', async () => {
  const fixture = makePublisherFixture({ existingPr: true, pushFails: true });

  await assert.rejects(publishPr([], fixture.dependencies), /push/i);

  const readyIndex = fixture.calls.findIndex(
    ([executable, scope, command, flag]) =>
      executable === 'gh' && scope === 'pr' && command === 'ready' && flag !== '--undo',
  );
  const pushIndex = fixture.calls.findIndex(
    ([executable, command]) => executable === 'git' && command === 'push',
  );
  const undoIndex = fixture.calls.findIndex(
    ([executable, scope, command, flag]) =>
      executable === 'gh' && scope === 'pr' && command === 'ready' && flag === '--undo',
  );
  assert.ok(readyIndex >= 0 && readyIndex < pushIndex, 'PR marked ready before the push attempt');
  assert.ok(undoIndex > pushIndex, 'failed push must return the PR to draft');
});

test('publisher surfaces inline review findings and blocks on live P0/P1 badges', async () => {
  const badge = severity =>
    `<img alt="${severity}" src="https://greptile-static-assets.s3.amazonaws.com/badges/${severity.toLowerCase()}.svg?v=9"> **Finding**`;
  const blocked = makePublisherFixture({
    existingPr: true,
    reviewComments: JSON.stringify([
      { position: 3, path: 'a.mjs', line: 10, body: 'style nit, no badge' },
      { position: null, path: 'b.mjs', original_line: 20, body: badge('P1') },
      { position: 7, path: 'c.mjs', line: 30, body: badge('P1') },
    ]),
  });
  await assert.rejects(
    publishPr(['--wait'], blocked.dependencies),
    /live P0\/P1 review finding.*c\.mjs:30/s,
  );

  const advisory = makePublisherFixture({
    existingPr: true,
    reviewComments: JSON.stringify([
      { position: 3, path: 'a.mjs', line: 10, body: 'style nit, no badge' },
      { position: null, path: 'b.mjs', original_line: 20, body: badge('P1') },
    ]),
  });
  await publishPr(['--wait'], advisory.dependencies);
});

test('publisher creates new PRs as non-draft after pushing the attested head', async () => {
  const fixture = makePublisherFixture({ existingPr: false });

  await publishPr(['--title', 'Publish ordering', '--body-file', 'pr-body.md'], fixture.dependencies);

  const createIndex = fixture.calls.findIndex(
    ([executable, scope, command]) => executable === 'gh' && scope === 'pr' && command === 'create',
  );
  const pushIndex = fixture.calls.findIndex(
    ([executable, command]) => executable === 'git' && command === 'push',
  );
  assert.ok(createIndex > pushIndex, 'new PR must be opened for the already-pushed attested head');
  assert.ok(!fixture.calls[createIndex].includes('--draft'), 'new PR must not be created as draft');
  assert.ok(!fixture.calls[createIndex].includes('--label'), 'labels stay opt-in');
});

test('publisher creates a labeled new PR as draft with labels before flipping it ready', async () => {
  const fixture = makePublisherFixture({ existingPr: false });

  await publishPr(
    [
      '--title',
      'Labeled change',
      '--body-file',
      'pr-body.md',
      '--label',
      'kind:chore',
      '--label',
      'release:manual',
    ],
    fixture.dependencies,
  );

  const create = fixture.calls.find(
    ([executable, scope, command]) => executable === 'gh' && scope === 'pr' && command === 'create',
  );
  const createIndex = fixture.calls.indexOf(create);
  const readyIndex = fixture.calls.findIndex(
    ([executable, scope, command]) =>
      executable === 'gh' && scope === 'pr' && command === 'ready',
  );
  assert.ok(create);
  assert.ok(create.includes('--draft'), 'labeled new PR must suppress CI on its opened event');
  assert.deepEqual(
    create.filter((argument, index) => create[index - 1] === '--label' || argument === '--label'),
    ['--label', 'kind:chore', '--label', 'release:manual'],
  );
  assert.ok(readyIndex > createIndex, 'labels must be attached before the ready-for-review event');
  assert.deepEqual(fixture.appliedLabels, ['kind:chore', 'release:manual']);
  assert.deepEqual(
    fixture.readyLabelSnapshots,
    [['kind:chore', 'release:manual']],
    'the first CI-triggering event must observe every requested label',
  );
});

test('publisher gates a new exception PR against its intended labels and body', async () => {
  const fixture = makePublisherFixture({ existingPr: false });
  const previousOfflineMode = process.env.CHANGE_BUDGET_USE_OFFLINE;

  await publishPr(
    [
      '--title',
      'Coherent oversized recovery',
      '--body-file',
      'pr-body.md',
      '--label',
      'change-budget:exception',
    ],
    fixture.dependencies,
  );

  assert.deepEqual(fixture.gateCalls, [{
    options: { baseRef: 'origin/main', changeBudgetException: true },
    exception: 'true',
    body: '## Change-budget exception\n\nDocumented test variance.\n',
    forceOffline: 'true',
  }]);
  assert.equal(process.env.CHANGE_BUDGET_USE_OFFLINE, previousOfflineMode);
});

test('publisher loudly reports a labeled new PR left draft when the ready flip fails', async () => {
  const fixture = makePublisherFixture({ existingPr: false, readyFails: true });

  await assert.rejects(
    publishPr(
      [
        '--title',
        'Labeled change',
        '--body-file',
        'pr-body.md',
        '--label',
        'kind:chore',
      ],
      fixture.dependencies,
    ),
    /created in draft.*remains in draft.*gh pr ready.*HTTP 502/s,
  );

  const create = fixture.calls.find(
    ([executable, scope, command]) => executable === 'gh' && scope === 'pr' && command === 'create',
  );
  assert.ok(create?.includes('--draft'));
});

test('publisher warns that a partially created labeled PR may remain draft', async () => {
  const fixture = makePublisherFixture({ existingPr: false, createFails: true });

  await assert.rejects(
    publishPr(
      [
        '--title',
        'Labeled change',
        '--body-file',
        'pr-body.md',
        '--label',
        'kind:chore',
      ],
      fixture.dependencies,
    ),
    /may now exist in draft with missing labels.*gh pr list --head work\/publish-ordering.*gh pr ready.*HTTP 502/s,
  );

  const create = fixture.calls.find(
    ([executable, scope, command]) => executable === 'gh' && scope === 'pr' && command === 'create',
  );
  assert.ok(create?.includes('--draft'));
});

test('publisher validates labels before push and remote attestation publication', async () => {
  const fixture = makePublisherFixture({ existingPr: false, invalidLabel: 'missing:label' });

  await assert.rejects(
    publishPr(
      [
        '--title',
        'Invalid label',
        '--body-file',
        'pr-body.md',
        '--label',
        'missing:label',
      ],
      fixture.dependencies,
    ),
    /Label "missing:label" does not exist or is not accessible.*before publishing.*HTTP 404/s,
  );

  assert.equal(
    fixture.calls.some(([executable, command]) => executable === 'git' && command === 'push'),
    false,
    'a bad label must stop before the exact-head push',
  );
  assert.equal(
    fixture.calls.some(
      call =>
        call[0] === 'gh'
        && call[1] === 'api'
        && call[2] === '--method'
        && call[3] === 'POST'
        && String(call[4]).includes('/statuses/'),
    ),
    false,
    'a bad label must stop before publishing the remote attestation',
  );
});

test('publisher applies labels to an existing PR through REST before pushing', async () => {
  const fixture = makePublisherFixture({ existingPr: true });

  await publishPr(
    ['--label', 'kind:chore', '--label', 'release:manual'],
    fixture.dependencies,
  );

  const labelIndex = fixture.calls.findIndex(
    call => call[0] === 'gh' && call.includes('repos/{owner}/{repo}/issues/191/labels'),
  );
  const pushIndex = fixture.calls.findIndex(
    ([executable, command]) => executable === 'git' && command === 'push',
  );
  assert.deepEqual(fixture.calls[labelIndex], [
    'gh',
    'api',
    '--method',
    'POST',
    'repos/{owner}/{repo}/issues/191/labels',
    '-f',
    'labels[]=kind:chore',
    '-f',
    'labels[]=release:manual',
  ]);
  assert.deepEqual(fixture.appliedLabels, ['kind:chore', 'release:manual']);
  assert.ok(labelIndex < pushIndex, 'existing PR labels must be applied before publishing a new head');
  assert.equal(
    fixture.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'edit'),
    false,
  );
});

test('publisher stops before push when applying an existing-PR label fails', async () => {
  const fixture = makePublisherFixture({ existingPr: true, labelUpdateFails: true });

  await assert.rejects(
    publishPr(['--label', 'kind:chore'], fixture.dependencies),
    /Failed to apply labels to PR #191 before push.*HTTP 422/s,
  );
  assert.equal(
    fixture.calls.some(([executable, command]) => executable === 'git' && command === 'push'),
    false,
  );
});
