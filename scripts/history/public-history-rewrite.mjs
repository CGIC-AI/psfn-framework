#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FILTER_REPO_PACKAGE_VERSION = '2.47.0';
export const REMOVED_HISTORY_PATHS = Object.freeze([
  '.agents/',
  '.beads/',
  '.claude/',
  '.codec/',
  '.codex/',
  '.cursor/',
  '.gemini/',
  '.github/workflows/trivy-config.yml',
  '.trivyignore.yaml',
  'context_packets/',
  'deploy/',
  'deployment/',
  'modules/',
  'shakedown/',
  'working_docs/',
]);

const ZERO_SHA = /^0{40}$/u;
const DEFAULT_MAIN_REF = 'refs/heads/main';
const MAX_BUFFER = 1024 * 1024 * 1024;

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd,
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function git(cwd, args, options = {}) {
  return run('git', args, { ...options, cwd });
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function sha256File(file) {
  return sha256(readFileSync(file));
}

function splitLines(raw) {
  return raw.trim() ? raw.trim().split('\n') : [];
}

function pythonBytesLiteral(value) {
  if (!/^[\x20-\x7e]*$/u.test(value)) {
    throw new Error('History rewrite patterns and replacements must be printable ASCII');
  }
  return `b'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export function parseArguments(argv) {
  const parsed = {
    mainRef: DEFAULT_MAIN_REF,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (argument === '--source') parsed.source = argv[++index];
    else if (argument === '--output') parsed.output = argv[++index];
    else if (argument === '--public-name') parsed.publicName = argv[++index];
    else if (argument === '--public-email') parsed.publicEmail = argv[++index];
    else if (argument === '--filter-repo') parsed.filterRepo = argv[++index];
    else if (argument === '--private-replacements') parsed.privateReplacements = argv[++index];
    else if (argument === '--private-remove-paths') parsed.privateRemovePaths = argv[++index];
    else if (argument === '--main-ref') parsed.mainRef = argv[++index];
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (parsed.help) return parsed;
  for (const key of [
    'source',
    'output',
    'publicName',
    'publicEmail',
    'filterRepo',
    'privateReplacements',
    'privateRemovePaths',
  ]) {
    if (typeof parsed[key] !== 'string' || parsed[key].trim().length === 0) {
      throw new Error(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
    }
  }
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(parsed.mainRef)) {
    throw new Error('--main-ref must name an exact refs/heads/* ref');
  }
  if (!/^[^\s@]+@[^\s@]+$/u.test(parsed.publicEmail)) {
    throw new Error('--public-email must be a syntactically valid public email');
  }
  return parsed;
}

export function builtInReplacementRules() {
  return [
    {
      kind: 'regex',
      pattern: '\\b100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(?:\\.\\d{1,3}){2}\\b(?!/)',
      replacement: '192.0.2.1',
      name: 'tailnet-address',
    },
    {
      kind: 'regex',
      pattern: '(?i)\\b[a-z0-9.-]+\\.local\\.internal\\b',
      replacement: 'host.example.invalid',
      name: 'internal-local-hostname',
    },
    {
      kind: 'regex',
      pattern: '(?i)\\buuid:\\s*[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\b',
      replacement: 'uuid: <redacted>',
      name: 'hardware-uuid',
    },
  ];
}

export function parseReplacementFile(raw, label = 'private replacement file') {
  const rules = [];
  for (const [index, sourceLine] of raw.split(/\r?\n/u).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('==>');
    if (separator < 1) {
      throw new Error(`${label}:${index + 1} must use PATTERN==>REPLACEMENT`);
    }
    const left = line.slice(0, separator);
    const replacement = line.slice(separator + 3);
    const renamePath = left.startsWith('path-regex:') || left.startsWith('path-literal:');
    const kind = left.startsWith('regex:') || left.startsWith('path-regex:')
      ? 'regex'
      : 'literal';
    const prefix = left.startsWith('path-regex:')
      ? 'path-regex:'
      : left.startsWith('path-literal:')
        ? 'path-literal:'
        : left.startsWith('regex:')
          ? 'regex:'
          : left.startsWith('literal:')
            ? 'literal:'
            : '';
    const pattern = left.slice(prefix.length);
    if (!pattern) throw new Error(`${label}:${index + 1} has an empty pattern`);
    rules.push({
      kind,
      pattern,
      replacement,
      name: `private-${index + 1}`,
      ...(renamePath ? { renamePath: true } : {}),
    });
  }
  return rules;
}

export function parsePrivateRemovalPaths(raw, label = 'private removal path file') {
  const paths = [];
  const seen = new Set();
  for (const [index, sourceLine] of raw.split(/\r?\n/u).entries()) {
    const file = sourceLine.trim();
    if (!file || file.startsWith('#')) continue;
    if (
      file.startsWith('/')
      || file.startsWith('../')
      || file.includes('/../')
      || file.includes('\\')
      || file.includes('\0')
    ) {
      throw new Error(`${label}:${index + 1} must be a normalized repository-relative path`);
    }
    if (seen.has(file)) throw new Error(`${label}:${index + 1} duplicates ${file}`);
    seen.add(file);
    paths.push(file);
  }
  if (paths.length === 0) throw new Error(`${label} must declare at least one path`);
  return paths;
}

export function isRemovedHistoryPath(file, removedPaths) {
  return removedPaths.some((removedPath) => (
    removedPath.endsWith('/') ? file.startsWith(removedPath) : file === removedPath
  ));
}

function javascriptRegex(rule) {
  let pattern = rule.pattern;
  let flags = 'gu';
  if (pattern.startsWith('(?i)')) {
    pattern = pattern.slice(4);
    flags += 'i';
  }
  return new RegExp(pattern, flags);
}

export function applyReplacementRules(value, rules) {
  let output = value;
  for (const rule of rules) {
    output = rule.kind === 'regex'
      ? output.replace(javascriptRegex(rule), rule.replacement)
      : output.replaceAll(rule.pattern, rule.replacement);
  }
  return output;
}

export function renameIdentityPath(file, rules) {
  return applyReplacementRules(
    file,
    rules
      .filter((rule) => rule.renamePath)
      .map((rule) => ({ ...rule, replacement: rule.replacement.toLowerCase() })),
  );
}

export function serializeFilterRepoReplacementRules(rules) {
  return `${rules.map((rule) => (
    `${rule.kind === 'regex' ? 'regex:' : 'literal:'}${rule.pattern}==>${rule.replacement}`
  )).join('\n')}\n`;
}

export function buildCommitCallback({ publicName, publicEmail, rules }) {
  const messageLines = [];
  for (const rule of rules) {
    if (rule.kind === 'regex') {
      messageLines.push(
        `commit.message = re.sub(${pythonBytesLiteral(rule.pattern)}, ${pythonBytesLiteral(rule.replacement)}, commit.message)`,
      );
    } else {
      messageLines.push(
        `commit.message = commit.message.replace(${pythonBytesLiteral(rule.pattern)}, ${pythonBytesLiteral(rule.replacement)})`,
      );
    }
  }
  return [
    'import re',
    ...messageLines,
    `commit.author_name = ${pythonBytesLiteral(publicName)}`,
    `commit.author_email = ${pythonBytesLiteral(publicEmail)}`,
    `commit.committer_name = ${pythonBytesLiteral(publicName)}`,
    `commit.committer_email = ${pythonBytesLiteral(publicEmail)}`,
  ].join('\n');
}

export function buildFilenameCallback(rules) {
  const lines = [
    'import re',
    'if filename is None:',
    '  return filename',
  ];
  for (const rule of rules.filter((candidate) => candidate.renamePath)) {
    lines.push(
      `filename = re.sub(${pythonBytesLiteral(rule.pattern)}, ${pythonBytesLiteral(rule.replacement.toLowerCase())}, filename)`,
    );
  }
  lines.push('return filename');
  return lines.join('\n');
}

export function parseCommitMap(raw) {
  const mapping = new Map();
  for (const line of splitLines(raw)) {
    const [oldSha, newSha] = line.trim().split(/\s+/u);
    if (/^[0-9a-f]{40}$/u.test(oldSha) && /^[0-9a-f]{40}$/u.test(newSha)) {
      mapping.set(oldSha, newSha);
    }
  }
  return mapping;
}

export function remapChangelogLinks(raw, commitMap) {
  const oldShas = [...commitMap.keys()];
  const projectSlug = ['ps', 'fn'].join('');
  const commitUrlPrefix = `https://github.com/CGIC-AI/${projectSlug}-framework/commit/`;
  const commitUrlPattern = new RegExp(
    `(${commitUrlPrefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})([0-9a-f]{7,40})`,
    'gu',
  );
  return raw.replace(
    commitUrlPattern,
    (match, prefix, abbreviatedSha) => {
      const candidates = oldShas.filter((sha) => sha.startsWith(abbreviatedSha));
      if (candidates.length !== 1) {
        throw new Error(`CHANGELOG commit ${abbreviatedSha} resolves to ${candidates.length} old commits`);
      }
      const rewritten = commitMap.get(candidates[0]);
      if (!rewritten || ZERO_SHA.test(rewritten)) {
        throw new Error(`CHANGELOG commit ${abbreviatedSha} did not survive the rewrite`);
      }
      return `${prefix}${rewritten}`;
    },
  );
}

export function parseRefMap(raw) {
  const refs = new Map();
  for (const line of splitLines(raw)) {
    const [ref, sha, type] = line.split('\t');
    if (!ref || !/^[0-9a-f]{40}$/u.test(sha) || !type) {
      throw new Error(`Malformed ref-map row: ${line}`);
    }
    refs.set(ref, { sha, type });
  }
  return refs;
}

export function classifyRemoteRef(ref) {
  if (ref.startsWith('refs/heads/')) return 'mutable-head';
  if (ref.startsWith('refs/tags/')) return 'mutable-tag';
  if (ref.startsWith('refs/pull/')) return 'server-owned';
  if (ref.startsWith('refs/dolt/')) return 'protected';
  return 'manual-review';
}

function leaseArguments(rows, direction) {
  const argumentsList = [];
  for (const row of rows) {
    const expected = direction === 'cutover' ? row.oldSha : row.newSha;
    const source = direction === 'cutover' ? row.newSha : row.oldSha;
    argumentsList.push(`--force-with-lease=${row.ref}:${expected}`, `${source}:${row.ref}`);
  }
  return argumentsList;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatPushCommand(rows, direction, mirrorPath) {
  if (rows.length === 0) return '(no refs in this category)';
  const argumentsList = leaseArguments(rows, direction);
  return [
    `cd ${shellQuote(mirrorPath)}`,
    ['git', 'push', '--atomic', ...argumentsList.map(shellQuote), 'REMOTE_URL'].join(' '),
  ].join('\n');
}

export function buildCutoverPlan({ beforeRefs, afterRefs, backupMirror, rewrittenMirror }) {
  const rows = [];
  const allRefs = new Set([...beforeRefs.keys(), ...afterRefs.keys()]);
  for (const ref of [...allRefs].sort()) {
    const before = beforeRefs.get(ref);
    const after = afterRefs.get(ref);
    rows.push({
      ref,
      oldSha: before?.sha ?? 'missing',
      newSha: after?.sha ?? 'missing',
      category: classifyRemoteRef(ref),
      changed: before?.sha !== after?.sha,
    });
  }
  const changed = rows.filter((row) => row.changed);
  const mutable = changed.filter((row) => (
    row.category === 'mutable-head' || row.category === 'mutable-tag'
  ));
  const blocked = changed.filter((row) => (
    row.category === 'server-owned' || row.category === 'manual-review'
  ));
  const protectedRows = rows.filter((row) => row.category === 'protected');
  const table = rows.map((row) => (
    `| \`${row.ref}\` | \`${row.oldSha}\` | \`${row.newSha}\` | ${row.category} | ${row.changed ? 'yes' : 'no'} |`
  )).join('\n');

  const markdown = `# Public history cutover plan

This artifact is review-only. Preparing the rewrite did not update a remote.
Never use \`git push --mirror\`: server-owned and protected refs require separate handling.

## Blocking remote condition

${blocked.length > 0
    ? `BLOCKED: ${blocked.length} changed server-owned or manual-review refs cannot be updated by the ordinary head/tag push. Keep the repository private until those refs are purged through repository recreation or an operator-approved hosting-provider procedure.`
    : 'No changed server-owned or manual-review refs were found.'}

Protected refs must remain byte-for-byte unchanged. This plan observed ${protectedRows.length} protected refs.

## Exact cutover command

Run only after reviewing the complete table and explicitly authorizing the cutover:

\`\`\`bash
${formatPushCommand(mutable, 'cutover', rewrittenMirror)}
\`\`\`

## Exact rollback command

Run from the backup mirror if the authorized cutover must be reversed:

\`\`\`bash
${formatPushCommand(mutable, 'rollback', backupMirror)}
\`\`\`

## Complete ref map

| Ref | Before | After | Category | Changed |
| --- | --- | --- | --- | --- |
${table}
`;
  return { blocked, markdown, mutable, rows };
}

function resolveExecutable(command) {
  if (command.includes('/')) return realpathSync(resolve(command));
  return realpathSync(run('which', [command]).trim());
}

export function verifyFilterRepoVersion(filterRepo) {
  const executable = resolveExecutable(filterRepo);
  const binDir = dirname(executable);
  const pythonCandidates = [join(binDir, 'python'), join(binDir, 'python3')];
  const python = pythonCandidates.find((candidate) => existsSync(candidate));
  if (!python) {
    throw new Error(`${executable} must come from a virtualenv with a sibling python executable`);
  }
  const version = run(python, [
    '-c',
    'import importlib.metadata as m; print(m.version("git-filter-repo"))',
  ]).trim();
  if (version !== FILTER_REPO_PACKAGE_VERSION) {
    throw new Error(
      `git-filter-repo ${FILTER_REPO_PACKAGE_VERSION} is required; ${executable} provides ${version}`,
    );
  }
  return { executable, version };
}

function refMap(cwd) {
  return git(cwd, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(objecttype)']);
}

function remoteRefMap(source) {
  const raw = run('git', ['ls-remote', source]);
  return raw.split('\n').filter((line) => line && !line.endsWith('\tHEAD')).sort().join('\n');
}

function directoryBytes(root) {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    total += entry.isDirectory() ? directoryBytes(target) : statSync(target).size;
  }
  return total;
}

function parseTree(raw) {
  const entries = new Map();
  for (const row of raw.split('\0').filter(Boolean)) {
    const separator = row.indexOf('\t');
    const [mode, type, sha] = row.slice(0, separator).split(' ');
    entries.set(row.slice(separator + 1), { mode, type, sha });
  }
  return entries;
}

function tree(cwd, ref) {
  return parseTree(git(cwd, ['ls-tree', '-rz', '-r', ref]));
}

function hashObject(cwd, contents) {
  const result = spawnSync('git', ['hash-object', '--stdin'], {
    cwd,
    input: contents,
    encoding: null,
    maxBuffer: MAX_BUFFER,
  });
  if (result.status !== 0) throw new Error(`git hash-object failed with ${String(result.status)}`);
  return result.stdout.toString('utf8').trim();
}

export function rewriteBlob(buffer, rules) {
  const source = buffer.toString('latin1');
  return Buffer.from(applyReplacementRules(source, rules), 'latin1');
}

function verifyFilteredMainTree({ backupMirror, rewrittenMirror, oldMain, filteredMain, rules, removedPaths }) {
  const before = tree(backupMirror, oldMain);
  const after = tree(rewrittenMirror, filteredMain);
  const expectedPaths = new Set();
  const mismatches = [];

  for (const [oldPath, oldEntry] of before) {
    const newPath = renameIdentityPath(oldPath, rules);
    if (isRemovedHistoryPath(oldPath, removedPaths)) {
      if (after.has(newPath)) mismatches.push(`${oldPath}: removed path remains`);
      continue;
    }
    expectedPaths.add(newPath);
    const newEntry = after.get(newPath);
    if (!newEntry) {
      mismatches.push(`${oldPath}: missing rewritten path ${newPath}`);
      continue;
    }
    if (oldEntry.mode !== newEntry.mode || oldEntry.type !== newEntry.type) {
      mismatches.push(`${oldPath}: mode/type changed`);
      continue;
    }
    if (oldEntry.type !== 'blob' || oldEntry.sha === newEntry.sha) continue;
    const oldBlob = git(backupMirror, ['cat-file', 'blob', oldEntry.sha], { encoding: null });
    const expectedSha = hashObject(rewrittenMirror, rewriteBlob(oldBlob, rules));
    if (expectedSha !== newEntry.sha) {
      mismatches.push(`${oldPath}: content changed outside declared replacements`);
    }
  }

  for (const newPath of after.keys()) {
    if (!expectedPaths.has(newPath)) mismatches.push(`${newPath}: unexplained added path`);
  }
  if (mismatches.length > 0) {
    throw new Error(`Filtered main tree has ${mismatches.length} unexplained changes:\n${mismatches.join('\n')}`);
  }
  return { comparedPaths: before.size, mismatches: 0 };
}

function scanRewrittenPatch({ rewrittenMirror, refs, rules, publicEmail }) {
  const patch = git(rewrittenMirror, [
    'log',
    '--no-ext-diff',
    '--no-textconv',
    '--format=fuller',
    '-p',
    ...refs,
  ]);
  const remaining = [];
  for (const rule of rules) {
    const transformed = applyReplacementRules(patch, [rule]);
    if (transformed !== patch) remaining.push(rule.name);
  }
  if (remaining.length > 0) {
    throw new Error(`Rewritten patch still matches replacement rules: ${remaining.join(', ')}`);
  }
  const emails = new Set(splitLines(git(rewrittenMirror, [
    'log',
    '--format=%ae%n%ce',
    ...refs,
  ])).map((email) => email.toLowerCase()));
  if (emails.size !== 1 || !emails.has(publicEmail.toLowerCase())) {
    throw new Error(`Rewritten commit identities are not singular: ${[...emails].join(', ')}`);
  }
}

function writeText(file, contents) {
  writeFileSync(file, contents.endsWith('\n') ? contents : `${contents}\n`, 'utf8');
}

function createPostRewriteCommit({
  rewrittenMirror,
  commitMap,
  publicName,
  publicEmail,
  mainRef,
  outputRoot,
}) {
  const checkout = mkdtempSync(join(outputRoot, '.materialize-'));
  try {
    run('git', ['clone', '--no-local', rewrittenMirror, checkout], { stdio: 'inherit' });
    git(checkout, ['checkout', '-B', 'history-rewrite-main', `origin/${mainRef.slice('refs/heads/'.length)}`]);
    const changelogPath = join(checkout, 'CHANGELOG.md');
    const remappedChangelog = remapChangelogLinks(readFileSync(changelogPath, 'utf8'), commitMap);
    writeText(changelogPath, remappedChangelog);

    git(checkout, ['add', '--', 'CHANGELOG.md']);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: publicName,
      GIT_AUTHOR_EMAIL: publicEmail,
      GIT_COMMITTER_NAME: publicName,
      GIT_COMMITTER_EMAIL: publicEmail,
    };
    git(checkout, [
      'commit',
      '-m',
      'chore(history): finalize public commit links',
    ], { env });
    const finalMain = git(checkout, ['rev-parse', 'HEAD']).trim();
    git(checkout, ['push', 'origin', `HEAD:${mainRef}`]);
    return finalMain;
  } finally {
    rmSync(checkout, { force: true, recursive: true });
  }
}

function usage() {
  return `Usage:
  node scripts/history/public-history-rewrite.mjs \\
    --source <remote-url-or-path> \\
    --output <new-output-directory> \\
    --public-name <name> \\
    --public-email <email> \\
    --filter-repo <path-to-pinned-git-filter-repo> \\
    --private-replacements <ignored-file> \\
    --private-remove-paths <ignored-file> \\
    [--main-ref refs/heads/main]

The command is prepare-only. It creates backup and rewritten mirrors, a complete
bundle, validation evidence, and exact cutover/rollback commands. It never pushes
to the source remote.`;
}

export function preparePublicHistoryRewrite(options) {
  const outputRoot = resolve(options.output);
  if (existsSync(outputRoot)) throw new Error(`Output path already exists: ${outputRoot}`);
  mkdirSync(dirname(outputRoot), { recursive: true });
  mkdirSync(outputRoot);

  const filterRepo = verifyFilterRepoVersion(options.filterRepo);
  const privateRules = parseReplacementFile(
    readFileSync(resolve(options.privateReplacements), 'utf8'),
    options.privateReplacements,
  );
  const rules = [...builtInReplacementRules(), ...privateRules];
  const privateRemovedPaths = parsePrivateRemovalPaths(
    readFileSync(resolve(options.privateRemovePaths), 'utf8'),
    options.privateRemovePaths,
  );
  const removedPaths = [...new Set([...REMOVED_HISTORY_PATHS, ...privateRemovedPaths])];
  const replacementsPath = join(outputRoot, 'filter-repo-replacements.txt');
  writeText(replacementsPath, serializeFilterRepoReplacementRules(rules));

  const remoteRefsBefore = remoteRefMap(options.source);
  const backupMirror = join(outputRoot, 'backup.git');
  const rewrittenMirror = join(outputRoot, 'rewritten.git');
  const bundlePath = join(outputRoot, 'pre-rewrite.bundle');
  run('git', ['clone', '--mirror', '--no-local', options.source, backupMirror], { stdio: 'inherit' });
  git(backupMirror, ['fsck', '--strict']);
  const beforeRefRaw = refMap(backupMirror);
  writeText(join(outputRoot, 'pre-refs.tsv'), beforeRefRaw);
  git(backupMirror, ['bundle', 'create', bundlePath, '--all'], { stdio: 'inherit' });

  run('git', ['clone', '--mirror', '--no-local', backupMirror, rewrittenMirror], { stdio: 'inherit' });
  const beforeRefs = parseRefMap(beforeRefRaw);
  const protectedRefs = [...beforeRefs.keys()].filter((ref) => classifyRemoteRef(ref) === 'protected');
  const rewrittenRefs = [...beforeRefs.keys()].filter((ref) => !protectedRefs.includes(ref));
  const filterArguments = [
    '--force',
    '--replace-text', replacementsPath,
    '--commit-callback', buildCommitCallback({ ...options, rules }),
    '--filename-callback', buildFilenameCallback(rules),
    '--prune-empty', 'never',
    ...removedPaths.flatMap((file) => ['--path', file]),
    '--invert-paths',
    '--refs',
    ...rewrittenRefs,
  ];
  run(filterRepo.executable, filterArguments, { cwd: rewrittenMirror, stdio: 'inherit' });

  const commitMapPath = join(rewrittenMirror, 'filter-repo', 'commit-map');
  const commitMap = parseCommitMap(readFileSync(commitMapPath, 'utf8'));
  const oldMain = beforeRefs.get(options.mainRef)?.sha;
  const filteredMain = commitMap.get(oldMain);
  if (!oldMain || !filteredMain || ZERO_SHA.test(filteredMain)) {
    throw new Error(`Main ref ${options.mainRef} did not survive the rewrite`);
  }
  const treeEvidence = verifyFilteredMainTree({
    backupMirror,
    rewrittenMirror,
    oldMain,
    filteredMain,
    rules,
    removedPaths,
  });
  const finalMain = createPostRewriteCommit({
    rewrittenMirror,
    commitMap,
    publicName: options.publicName,
    publicEmail: options.publicEmail,
    mainRef: options.mainRef,
    outputRoot,
  });

  git(rewrittenMirror, ['fsck', '--strict']);
  const postRefRaw = refMap(rewrittenMirror);
  writeText(join(outputRoot, 'post-refs.tsv'), postRefRaw);
  const afterRefs = parseRefMap(postRefRaw);
  if ([...beforeRefs.keys()].sort().join('\n') !== [...afterRefs.keys()].sort().join('\n')) {
    throw new Error('Ref-name coverage changed during rewrite');
  }
  for (const ref of protectedRefs) {
    if (beforeRefs.get(ref)?.sha !== afterRefs.get(ref)?.sha) {
      throw new Error(`Protected ref changed: ${ref}`);
    }
  }

  const reachableRefs = [...afterRefs.keys()].filter((ref) => classifyRemoteRef(ref) !== 'protected');
  scanRewrittenPatch({
    rewrittenMirror,
    refs: reachableRefs,
    rules,
    publicEmail: options.publicEmail,
  });
  const reachableObjects = git(rewrittenMirror, ['rev-list', '--objects', ...reachableRefs]);
  const reachableObjectPaths = reachableObjects.split('\n').map((row) => (
    row.includes(' ') ? row.slice(row.indexOf(' ') + 1) : ''
  )).filter(Boolean);
  for (const removedPath of removedPaths) {
    if (reachableObjectPaths.some((file) => isRemovedHistoryPath(file, [removedPath]))) {
      throw new Error(`Removed history path remains reachable: ${removedPath}`);
    }
  }

  const finalChangedPaths = splitLines(git(rewrittenMirror, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    filteredMain,
    finalMain,
  ])).sort();
  const expectedFinalPaths = ['CHANGELOG.md'];
  if (finalChangedPaths.join('\n') !== expectedFinalPaths.join('\n')) {
    throw new Error(`Post-rewrite commit changed unexpected paths: ${finalChangedPaths.join(', ')}`);
  }

  const cloneRoot = mkdtempSync(join(outputRoot, '.clone-measure-'));
  let cloneMetrics;
  try {
    const beforeClone = join(cloneRoot, 'before');
    const afterClone = join(cloneRoot, 'after');
    run('git', ['clone', '--no-local', backupMirror, beforeClone], { stdio: 'inherit' });
    run('git', ['clone', '--no-local', rewrittenMirror, afterClone], { stdio: 'inherit' });
    cloneMetrics = {
      beforeObjectBytes: directoryBytes(join(beforeClone, '.git', 'objects')),
      afterObjectBytes: directoryBytes(join(afterClone, '.git', 'objects')),
    };
  } finally {
    rmSync(cloneRoot, { force: true, recursive: true });
  }

  const remoteRefsAfter = remoteRefMap(options.source);
  if (remoteRefsBefore !== remoteRefsAfter) {
    throw new Error('Source remote refs moved during preparation; artifacts are not a coherent cutover set');
  }

  const cutover = buildCutoverPlan({
    beforeRefs,
    afterRefs,
    backupMirror,
    rewrittenMirror,
  });
  writeText(join(outputRoot, 'CUTOVER_PLAN.md'), cutover.markdown);
  const report = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    source: options.source,
    sourceRefsSha256: sha256(remoteRefsBefore),
    backupBundle: {
      path: bundlePath,
      bytes: statSync(bundlePath).size,
      sha256: sha256File(bundlePath),
    },
    refCounts: {
      before: beforeRefs.size,
      after: afterRefs.size,
      changed: cutover.rows.filter((row) => row.changed).length,
      serverOwnedOrManualBlockers: cutover.blocked.length,
    },
    cloneMetrics,
    history: {
      filterRepoVersion: filterRepo.version,
      removedPaths,
      mainBefore: oldMain,
      mainFiltered: filteredMain,
      mainFinal: finalMain,
      treeComparedPaths: treeEvidence.comparedPaths,
      unexplainedTreeMismatches: treeEvidence.mismatches,
    },
    identities: {
      publicName: options.publicName,
      publicEmail: options.publicEmail,
    },
    remoteMutationPerformed: false,
  };
  writeText(join(outputRoot, 'validation-report.json'), JSON.stringify(report, null, 2));
  return { cutover, outputRoot, report };
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = preparePublicHistoryRewrite(options);
    console.log(`Prepared and validated history artifacts at ${result.outputRoot}`);
    console.log(`Remote mutation performed: ${String(result.report.remoteMutationPerformed)}`);
    if (result.cutover.blocked.length > 0) {
      console.log(
        `Cutover remains blocked by ${result.cutover.blocked.length} server-owned/manual-review ref updates; see CUTOVER_PLAN.md.`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
