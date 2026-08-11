import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyReplacementRules,
  buildCommitCallback,
  buildCutoverPlan,
  buildFilenameCallback,
  builtInReplacementRules,
  classifyRemoteRef,
  isRemovedHistoryPath,
  parseArguments,
  parseCommitMap,
  parsePrivateRemovalPaths,
  parseReplacementFile,
  remapChangelogLinks,
  renameIdentityPath,
  rewriteBlob,
  serializeFilterRepoReplacementRules,
} from '../history/public-history-rewrite.mjs';

const PUBLIC_IDENTITY = Object.freeze({
  publicName: 'PSFN Maintainer',
  publicEmail: 'maintainer@example.invalid',
});

test('history rewrite arguments require explicit source, output, identity, and pinned tool', () => {
  assert.deepEqual(parseArguments([
    '--source', 'https://example.invalid/repository.git',
    '--output', 'workspace/history-rewrite/example',
    '--public-name', PUBLIC_IDENTITY.publicName,
    '--public-email', PUBLIC_IDENTITY.publicEmail,
    '--filter-repo', '/opt/tools/git-filter-repo',
    '--private-replacements', 'workspace/history-rewrite/private-replacements.txt',
    '--private-remove-paths', 'workspace/history-rewrite/private-remove-paths.txt',
  ]), {
    filterRepo: '/opt/tools/git-filter-repo',
    mainRef: 'refs/heads/main',
    output: 'workspace/history-rewrite/example',
    privateRemovePaths: 'workspace/history-rewrite/private-remove-paths.txt',
    privateReplacements: 'workspace/history-rewrite/private-replacements.txt',
    publicEmail: PUBLIC_IDENTITY.publicEmail,
    publicName: PUBLIC_IDENTITY.publicName,
    source: 'https://example.invalid/repository.git',
  });
  assert.throws(() => parseArguments([]), /--source is required/u);
  assert.throws(() => parseArguments([
    '--source', 'repo',
    '--output', 'out',
    '--public-name', 'Maintainer',
    '--public-email', 'invalid',
    '--filter-repo', 'git-filter-repo',
    '--private-replacements', 'private.txt',
    '--private-remove-paths', 'remove-paths.txt',
  ]), /syntactically valid/u);
});

test('generic and ignored-local rules sanitize text, callbacks, and identity-bearing paths', () => {
  const rules = [
    ...builtInReplacementRules(),
    ...parseReplacementFile('path-regex:(?i)private-companion==>companion'),
  ];
  const tailnetAddress = ['100', '64', '0', '1'].join('.');
  const source = `private-companion at ${tailnetAddress}`;
  assert.equal(
    applyReplacementRules(source, rules),
    'companion at 192.0.2.1',
  );
  assert.equal(
    renameIdentityPath('deployment/private-companion-watchdog.service', rules),
    'deployment/companion-watchdog.service',
  );
  assert.match(serializeFilterRepoReplacementRules(rules), /regex:/u);
  assert.match(buildCommitCallback({ ...PUBLIC_IDENTITY, rules }), /commit\.author_email/u);
  assert.match(buildFilenameCallback(rules), /if filename is None:\n  return filename/u);
  assert.deepEqual(
    rewriteBlob(Buffer.from('café private-companion', 'utf8'), rules),
    Buffer.from('café companion', 'utf8'),
  );
});

test('private replacement files accept literal and regex rules and reject malformed rows', () => {
  assert.deepEqual(parseReplacementFile([
    '# local only',
    'literal:old-host==>host.example.invalid',
    'path-regex:(?i)private-user==>example-user',
    '',
  ].join('\n')), [
    {
      kind: 'literal',
      name: 'private-2',
      pattern: 'old-host',
      replacement: 'host.example.invalid',
    },
    {
      kind: 'regex',
      name: 'private-3',
      pattern: '(?i)private-user',
      replacement: 'example-user',
      renamePath: true,
    },
  ]);
  assert.throws(() => parseReplacementFile('missing separator'), /PATTERN==>REPLACEMENT/u);
});

test('private removal paths are normalized, unique, and explicitly supplied', () => {
  assert.deepEqual(parsePrivateRemovalPaths([
    '# ignored local inventory',
    'working_docs/example-session.zip',
    'deployment/private-model.tflite',
  ].join('\n')), [
    'working_docs/example-session.zip',
    'deployment/private-model.tflite',
  ]);
  assert.throws(() => parsePrivateRemovalPaths('../outside'), /repository-relative/u);
  assert.throws(() => parsePrivateRemovalPaths('same\nsame'), /duplicates/u);
  assert.throws(() => parsePrivateRemovalPaths('# only comments'), /at least one/u);
  assert.equal(isRemovedHistoryPath('working_docs/nested/note.md', ['working_docs/']), true);
  assert.equal(isRemovedHistoryPath('docs/public.md', ['working_docs/']), false);
});

test('changelog links remap to rewritten SHAs and reject pruned commits', () => {
  const oldSha = '1'.repeat(40);
  const newSha = '2'.repeat(40);
  const map = parseCommitMap(`old                                      new\n${oldSha} ${newSha}\n`);
  assert.equal(
    remapChangelogLinks(
      `https://github.com/CGIC-AI/psfn-framework/commit/${oldSha}`,
      map,
    ),
    `https://github.com/CGIC-AI/psfn-framework/commit/${newSha}`,
  );
  assert.throws(
    () => remapChangelogLinks(
      `https://github.com/CGIC-AI/psfn-framework/commit/${oldSha}`,
      new Map([[oldSha, '0'.repeat(40)]]),
    ),
    /did not survive/u,
  );
});

test('cutover plans update only mutable heads/tags and block server-owned rewritten refs', () => {
  const beforeRefs = new Map([
    ['refs/heads/main', { sha: '1'.repeat(40), type: 'commit' }],
    ['refs/pull/1/head', { sha: '2'.repeat(40), type: 'commit' }],
    ['refs/dolt/data', { sha: '3'.repeat(40), type: 'commit' }],
  ]);
  const afterRefs = new Map([
    ['refs/heads/main', { sha: '4'.repeat(40), type: 'commit' }],
    ['refs/pull/1/head', { sha: '5'.repeat(40), type: 'commit' }],
    ['refs/dolt/data', { sha: '3'.repeat(40), type: 'commit' }],
  ]);
  const plan = buildCutoverPlan({
    beforeRefs,
    afterRefs,
    backupMirror: '/safe/backup.git',
    rewrittenMirror: '/safe/rewritten.git',
  });
  assert.equal(classifyRemoteRef('refs/heads/main'), 'mutable-head');
  assert.equal(classifyRemoteRef('refs/pull/1/head'), 'server-owned');
  assert.equal(classifyRemoteRef('refs/dolt/data'), 'protected');
  assert.equal(plan.mutable.length, 1);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.markdown, /--force-with-lease=refs\/heads\/main:/u);
  assert.match(plan.markdown, /BLOCKED:/u);
  const commandBlocks = [...plan.markdown.matchAll(/```bash\n([\s\S]*?)```/gu)]
    .map((match) => match[1])
    .join('\n');
  assert.doesNotMatch(commandBlocks, /push --mirror/u);
});
