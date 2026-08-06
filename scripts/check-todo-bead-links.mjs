#!/usr/bin/env node

/**
 * Fail-closed TODO-requires-bead gate.
 *
 * Repository convention: every work marker in a source comment names the bead
 * that owns the follow-up, written as `MARKER(bead-ref)`, for example
 * `TODO(htm9.2-followup)`. This gate keeps the convention universal: any
 * `TODO`, `FIXME`, `HACK`, or `XXX` marker in a scanned comment must be
 * immediately followed by `(bead-ref)`, or be explicitly grandfathered in
 * config/todo-comment-baseline.json with a reviewed note.
 *
 * Scanned trees and extensions (relative to the current working directory):
 *   src (recursive): .ts
 *   scripts (recursive): .ts, .mjs
 *   companion-ui/src (recursive): .ts, .tsx
 *   admin-ui/src (recursive): .ts, .svelte
 *
 * Exclusions (deliberate):
 *   - node_modules directories anywhere under a scan root (third-party code
 *     is not held to this repository's conventions).
 *   - *.test.* files (tests legitimately embed marker words in fixtures and
 *     assertions about this gate).
 *   - this script itself (its own documentation necessarily discusses bare
 *     marker words), mirroring the self-exclusion in
 *     scripts/identity-literal-scan.mjs.
 * Missing scan roots are skipped so the gate also runs inside small fixtures.
 *
 * Only comments are scanned: `//` line comments, C-style block comments, and
 * (for .svelte files) HTML comments. String and template literals are skipped
 * so examples such as 'TODO' inside a search-query literal are not flagged.
 * Regex literals are skipped with the usual heuristic (a `/` after an
 * operand-ending character is division, otherwise it opens a regex); the
 * scanner is deliberately simple and documented rather than a full parser.
 *
 * Bead-ref shape, derived from the two real conventions in use —
 * `htm9.2-followup` and `psfn-framework-8genb`: one or more lowercase
 * alphanumeric segments joined by dots or dashes:
 *   [a-z0-9]+(?:[.-][a-z0-9]+)*
 *
 * Default mode FAILS on:
 *   - any marker without a valid bead ref that is not baselined, and
 *   - any stale baseline entry (path/line/excerpt no longer matches a current
 *     violation), so the baseline cannot rot.
 *
 * Updating is reduction-only, mirroring scripts/verify-typecheck-baseline.mjs:
 *   node scripts/check-todo-bead-links.mjs --update
 * drops stale entries but refuses to add new ones. Grandfathering a new
 * violation means hand-authoring its entry with a non-empty note explaining
 * why; fixing the comment to name its bead is almost always the right move.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const REPOSITORY_ROOT = process.cwd();
const DEFAULT_BASELINE_PATH = resolve(REPOSITORY_ROOT, 'config/todo-comment-baseline.json');
const SELF_PATH = 'scripts/check-todo-bead-links.mjs';

const SCAN_TREES = [
  { root: 'src', extensions: ['.ts'] },
  { root: 'scripts', extensions: ['.ts', '.mjs'] },
  { root: 'companion-ui/src', extensions: ['.ts', '.tsx'] },
  { root: 'admin-ui/src', extensions: ['.ts', '.svelte'] },
];

// Word-boundaried so `XXX` inside a longer identifier does not count, while
// `XXX:` at the start of a comment does.
const MARKER_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/gu;
const BEAD_REF_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const MAX_EXCERPT_LENGTH = 160;

function printUsage() {
  console.log('Usage: node scripts/check-todo-bead-links.mjs [options]');
  console.log('');
  console.log('Requires every TODO/FIXME/HACK/XXX comment marker to name its bead,');
  console.log('e.g. TODO(htm9.2-followup), unless grandfathered in the baseline.');
  console.log('');
  console.log('Options:');
  console.log('  --baseline <path>  Override the baseline JSON path');
  console.log('  --update           Drop stale baseline entries (never adds entries)');
  console.log('  -h, --help         Show this help');
}

function parseArgs(argv) {
  let baselinePath = DEFAULT_BASELINE_PATH;
  let update = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--baseline') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --baseline');
      }
      baselinePath = resolve(REPOSITORY_ROOT, value);
      index += 1;
      continue;
    }
    if (argument === '--update') {
      update = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { baselinePath, update };
}

function normalizePath(pathValue) {
  const absolutePath = resolve(REPOSITORY_ROOT, pathValue);
  return relative(REPOSITORY_ROOT, absolutePath).replaceAll('\\', '/');
}

function isExcludedFile(relativePath) {
  if (relativePath === SELF_PATH) {
    return true;
  }
  if (relativePath.split('/').includes('node_modules')) {
    return true;
  }
  return basename(relativePath).includes('.test.');
}

function collectSourceFiles(root, extensions) {
  const absoluteRoot = resolve(REPOSITORY_ROOT, root);
  if (!existsSync(absoluteRoot)) {
    return [];
  }
  const files = [];
  const pending = [absoluteRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') {
          pending.push(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = normalizePath(absolutePath);
      if (isExcludedFile(relativePath)) {
        continue;
      }
      if (extensions.some(extension => entry.name.endsWith(extension))) {
        files.push(relativePath);
      }
    }
  }
  return files.sort();
}

function lineStartsFor(sourceText) {
  const starts = [0];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineNumberFor(lineStarts, charIndex) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= charIndex) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}

function lineTextFor(sourceText, lineStarts, lineNumber) {
  const start = lineStarts[lineNumber - 1];
  let end = sourceText.indexOf('\n', start);
  if (end === -1) {
    end = sourceText.length;
  }
  return sourceText.slice(start, end);
}

/**
 * Walks source text and returns every comment as { index, text } pairs where
 * `index` is the absolute character offset of the comment's first content
 * character. Code, strings, template literals, and regex literals are
 * skipped; see the header for the regex heuristic's documented limitation.
 */
function extractComments(sourceText, { htmlComments }) {
  const comments = [];
  // Characters that can end an operand: after one of these a `/` is division;
  // after anything else (operators, keywords, `(`, start of file) it opens a
  // regex literal. Keywords like `return` are word characters, so they are
  // misread as operands — the documented cost of a parser-free heuristic.
  const operandEnders = new Set([')', ']', '}', "'", '"', '`']);
  let index = 0;
  // Stack of template-literal interpolation depths; each entry is the brace
  // depth at which the enclosing `${` opened.
  const templateDepths = [];
  let braceDepth = 0;

  const previousSignificantChar = (beforeIndex) => {
    for (let cursor = beforeIndex - 1; cursor >= 0; cursor -= 1) {
      const char = sourceText[cursor];
      if (!/\s/u.test(char)) {
        return char;
      }
    }
    return '';
  };

  while (index < sourceText.length) {
    const char = sourceText[index];
    const next = sourceText[index + 1] ?? '';

    if (char === '/' && next === '/') {
      let end = sourceText.indexOf('\n', index + 2);
      if (end === -1) {
        end = sourceText.length;
      }
      comments.push({ index: index + 2, text: sourceText.slice(index + 2, end) });
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = sourceText.indexOf('*/', index + 2);
      const end = close === -1 ? sourceText.length : close;
      comments.push({ index: index + 2, text: sourceText.slice(index + 2, end) });
      index = close === -1 ? sourceText.length : close + 2;
      continue;
    }
    if (htmlComments && char === '<' && sourceText.startsWith('!--', index + 1)) {
      const close = sourceText.indexOf('-->', index + 4);
      const end = close === -1 ? sourceText.length : close;
      comments.push({ index: index + 4, text: sourceText.slice(index + 4, end) });
      index = close === -1 ? sourceText.length : close + 3;
      continue;
    }
    if (char === "'" || char === '"') {
      index += 1;
      while (index < sourceText.length && sourceText[index] !== char) {
        index += sourceText[index] === '\\' ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (char === '`') {
      index += 1;
      while (index < sourceText.length) {
        if (sourceText[index] === '\\') {
          index += 2;
          continue;
        }
        if (sourceText[index] === '`') {
          index += 1;
          break;
        }
        if (sourceText[index] === '$' && sourceText[index + 1] === '{') {
          templateDepths.push(braceDepth);
          braceDepth += 1;
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      braceDepth -= 1;
      if (templateDepths.length > 0 && braceDepth === templateDepths[templateDepths.length - 1]) {
        // Closing the `${` interpolation: the rest of the template follows.
        templateDepths.pop();
        index += 1;
        while (index < sourceText.length) {
          if (sourceText[index] === '\\') {
            index += 2;
            continue;
          }
          if (sourceText[index] === '`') {
            index += 1;
            break;
          }
          if (sourceText[index] === '$' && sourceText[index + 1] === '{') {
            templateDepths.push(braceDepth);
            braceDepth += 1;
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 1;
      continue;
    }
    if (char === '/' && next !== '/' && next !== '*') {
      const previous = previousSignificantChar(index);
      const isDivision = previous !== '' && (
        /[\w$]/u.test(previous) || operandEnders.has(previous)
      );
      if (!isDivision) {
        // Regex literal: consume to the closing unescaped `/` (char-class aware).
        index += 1;
        let inClass = false;
        while (index < sourceText.length) {
          const regexChar = sourceText[index];
          if (regexChar === '\\') {
            index += 2;
            continue;
          }
          if (regexChar === '\n') {
            break;
          }
          if (regexChar === '[') {
            inClass = true;
          } else if (regexChar === ']') {
            inClass = false;
          } else if (regexChar === '/' && !inClass) {
            index += 1;
            while (index < sourceText.length && /[a-z]/u.test(sourceText[index])) {
              index += 1;
            }
            break;
          }
          index += 1;
        }
        continue;
      }
    }
    index += 1;
  }

  return comments;
}

function findViolationsInFile(relativePath) {
  const sourceText = readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8');
  const lineStarts = lineStartsFor(sourceText);
  const comments = extractComments(sourceText, {
    htmlComments: relativePath.endsWith('.svelte'),
  });
  const violations = [];
  let linkedCount = 0;

  for (const comment of comments) {
    for (const match of comment.text.matchAll(MARKER_PATTERN)) {
      const marker = match[1];
      const afterMarker = comment.text.slice(match.index + marker.length);
      const beadMatch = afterMarker.match(/^\(([a-z0-9]+(?:[.-][a-z0-9]+)*)\)/u);
      if (beadMatch && BEAD_REF_PATTERN.test(beadMatch[1])) {
        linkedCount += 1;
        continue;
      }
      const charIndex = comment.index + match.index;
      const line = lineNumberFor(lineStarts, charIndex);
      let excerpt = lineTextFor(sourceText, lineStarts, line).trim();
      if (excerpt.length > MAX_EXCERPT_LENGTH) {
        excerpt = `${excerpt.slice(0, MAX_EXCERPT_LENGTH)}...`;
      }
      violations.push({
        path: relativePath,
        line,
        marker,
        excerpt,
      });
    }
  }

  return { linkedCount, violations };
}

function scanMarkers() {
  const perTree = [];
  const violations = [];
  let filesScanned = 0;
  let markersLinked = 0;

  for (const tree of SCAN_TREES) {
    const files = collectSourceFiles(tree.root, tree.extensions);
    let treeViolations = 0;
    let treeLinked = 0;
    for (const relativePath of files) {
      const result = findViolationsInFile(relativePath);
      treeViolations += result.violations.length;
      treeLinked += result.linkedCount;
      violations.push(...result.violations);
    }
    perTree.push({
      root: tree.root,
      files: files.length,
      markers: treeViolations + treeLinked,
    });
    filesScanned += files.length;
    markersLinked += treeLinked;
  }

  violations.sort(compareEntries);
  return {
    filesScanned,
    markersLinked,
    markersTotal: markersLinked + violations.length,
    perTree,
    violations,
  };
}

function entryKey(entry) {
  return `${entry.path}${entry.line}${entry.marker}${entry.excerpt}`;
}

function compareEntries(left, right) {
  return left.path.localeCompare(right.path)
    || (left.line - right.line)
    || left.marker.localeCompare(right.marker)
    || left.excerpt.localeCompare(right.excerpt);
}

function readBaseline(baselinePath) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read baseline ${normalizePath(baselinePath)}: ${error.message}`);
  }

  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('TODO-comment baseline must be a JSON object.');
  }
  if (baseline.schemaVersion !== 1) {
    throw new Error(`Unsupported TODO-comment baseline schemaVersion: ${baseline.schemaVersion}`);
  }
  if (!Array.isArray(baseline.entries)) {
    throw new Error('TODO-comment baseline entries must be an array.');
  }

  const seen = new Set();
  for (const entry of baseline.entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Every TODO-comment baseline entry must be an object.');
    }
    for (const field of ['path', 'marker', 'excerpt']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        throw new Error(`Every TODO-comment baseline entry ${field} must be a non-empty string.`);
      }
    }
    if (!Number.isInteger(entry.line) || entry.line <= 0) {
      throw new Error(`Every TODO-comment baseline entry line must be a positive integer: ${entry.path}`);
    }
    if (typeof entry.note !== 'string' || entry.note.trim().length === 0) {
      throw new Error(
        `TODO-comment baseline entry ${entry.path}:${entry.line} has an empty note; `
        + 'every grandfathered marker needs a reviewed justification.',
      );
    }
    const key = entryKey(entry);
    if (seen.has(key)) {
      throw new Error(`Duplicate TODO-comment baseline entry: ${entry.path}:${entry.line} ${entry.marker}`);
    }
    seen.add(key);
  }

  const sortedEntries = [...baseline.entries].sort(compareEntries);
  if (JSON.stringify(sortedEntries) !== JSON.stringify(baseline.entries)) {
    throw new Error('TODO-comment baseline entries must be sorted by path, line, marker, and excerpt.');
  }

  return baseline;
}

function partitionByBaseline(violations, baseline) {
  const remaining = new Map();
  for (const entry of baseline.entries) {
    remaining.set(entryKey(entry), (remaining.get(entryKey(entry)) ?? 0) + 1);
  }
  const unbaselined = [];
  const baselined = [];
  for (const violation of violations) {
    const key = entryKey(violation);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
      baselined.push(violation);
    } else {
      unbaselined.push(violation);
    }
  }
  return { baselined, unbaselined };
}

function findStaleEntries(baseline, violations) {
  const currentKeys = new Set(violations.map(entryKey));
  return baseline.entries.filter(entry => !currentKeys.has(entryKey(entry)));
}

function formatViolations(violations) {
  return violations
    .map(entry => `  + ${entry.path}:${entry.line} ${entry.marker}: ${entry.excerpt}`)
    .join('\n');
}

function formatStale(entries) {
  return entries
    .map(entry => `  - ${entry.path}:${entry.line} ${entry.marker}: ${entry.excerpt}`)
    .join('\n');
}

function writeBaseline(baselinePath, entries) {
  const temporaryPath = `${baselinePath}.${process.pid}.tmp`;
  mkdirSync(dirname(baselinePath), { recursive: true });
  const entryLines = entries.map((entry, index) => {
    const suffix = index === entries.length - 1 ? '' : ',';
    return `    ${JSON.stringify(entry)}${suffix}`;
  });
  const entriesBlock = entryLines.length === 0
    ? '  "entries": []'
    : ['  "entries": [', ...entryLines, '  ]'].join('\n');
  const serialized = [
    '{',
    '  "schemaVersion": 1,',
    entriesBlock,
    '}',
    '',
  ].join('\n');
  try {
    writeFileSync(temporaryPath, serialized, 'utf8');
    renameSync(temporaryPath, baselinePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function reportInventory(scan) {
  const trees = scan.perTree
    .map(tree => `${tree.root} (${tree.files} file(s), ${tree.markers} marker(s))`)
    .join(', ');
  console.log(
    `[check-todo-bead-links] scanned ${scan.filesScanned} file(s): ${trees}. `
    + `${scan.markersTotal} marker(s) total, ${scan.markersLinked} with a bead ref.`,
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const baselineExists = existsSync(options.baselinePath);
  let existingBaseline;

  if (baselineExists) {
    existingBaseline = readBaseline(options.baselinePath);
  } else if (!options.update) {
    throw new Error(
      `Missing ${normalizePath(options.baselinePath)}. `
      + 'Generate the initial reviewed baseline with --update.',
    );
  }

  const scan = scanMarkers();
  reportInventory(scan);

  if (options.update) {
    if (existingBaseline) {
      const { unbaselined } = partitionByBaseline(scan.violations, existingBaseline);
      if (unbaselined.length > 0) {
        throw new Error(
          'Refusing to update the baseline because it would add entries; '
          + `link these markers to a bead or hand-author reviewed entries:\n${formatViolations(unbaselined)}`,
        );
      }
      const notes = new Map(existingBaseline.entries.map(entry => [entryKey(entry), entry.note]));
      const surviving = scan.violations.map(entry => ({ ...entry, note: notes.get(entryKey(entry)) }));
      writeBaseline(options.baselinePath, surviving);
      const pruned = existingBaseline.entries.length - surviving.length;
      console.log(
        `[check-todo-bead-links] wrote ${normalizePath(options.baselinePath)}: `
        + `${surviving.length} entries, pruned ${pruned} stale entries.`,
      );
      return;
    }

    if (scan.violations.length > 0) {
      throw new Error(
        'Refusing to create the initial baseline with unlinked markers; '
        + 'link them to a bead or hand-author reviewed entries:\n'
        + formatViolations(scan.violations),
      );
    }
    writeBaseline(options.baselinePath, []);
    console.log(
      `[check-todo-bead-links] wrote ${normalizePath(options.baselinePath)}: 0 entries (no unlinked markers).`,
    );
    return;
  }

  const { unbaselined } = partitionByBaseline(scan.violations, existingBaseline);
  const stale = findStaleEntries(existingBaseline, scan.violations);
  const failures = [];
  if (unbaselined.length > 0) {
    failures.push(
      `${unbaselined.length} marker(s) without a bead ref and not baselined:\n${formatViolations(unbaselined)}`,
    );
  }
  if (stale.length > 0) {
    failures.push(
      `${stale.length} stale baseline entries no longer present in the tree; `
      + `prune with --update:\n${formatStale(stale)}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`TODO-comment check failed:\n${failures.join('\n')}`);
  }

  console.log(
    `[check-todo-bead-links] PASS: every marker names its bead or is baselined `
    + `(${scan.violations.length} baselined, ${scan.markersLinked} linked).`,
  );
}

try {
  main();
} catch (error) {
  console.error(`[check-todo-bead-links] FAIL: ${error.message}`);
  process.exitCode = 1;
}
