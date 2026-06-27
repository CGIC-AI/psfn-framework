#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const ALLOWED_IS_RECORD_FILE = 'src/shared/utils/types.ts';
const PROJECT_PREFIX = ['P', 'S', 'F', 'N'].join('');
const IGNORED_PREFIXES = [
  'node_modules/',
  'dist/',
  'admin-ui/.svelte-kit/',
  'admin-ui/build/',
  'companion-ui/dist/',
  `${PROJECT_PREFIX}-Satellite-Hub/`,
];

const DISALLOWED_PATTERNS = [
  {
    name: 'local isRecord function',
    pattern: /(?:^|\n)(?:export\s+)?function\s+isRecord\s*\(/g,
    allow: (file) => file === ALLOWED_IS_RECORD_FILE,
  },
  {
    name: 'local method isRecord',
    pattern: /(?:^|\n)\s*(?:public|private|protected)\s+isRecord\s*\(/g,
    allow: () => false,
  },
  {
    name: 'local isRecordValue function',
    pattern: /(?:^|\n)(?:export\s+)?function\s+isRecordValue\s*\(/g,
    allow: () => false,
  },
  {
    name: 'production local isObjectRecord function',
    pattern: /(?:^|\n)(?:export\s+)?function\s+isObjectRecord\s*\(/g,
    allow: (file) => file === ALLOWED_IS_RECORD_FILE || file.endsWith('.test.ts'),
  },
];

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => existsSync(file))
    .filter((file) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file))
    .filter((file) => !IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

function lineForOffset(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

const violations = [];

for (const file of trackedFiles()) {
  const text = readFileSync(file, 'utf8');
  for (const rule of DISALLOWED_PATTERNS) {
    if (rule.allow(file)) continue;
    for (const match of text.matchAll(rule.pattern)) {
      violations.push({
        file,
        line: lineForOffset(text, match.index ?? 0),
        name: rule.name,
      });
    }
  }
}

if (violations.length > 0) {
  console.error('Shared type guard verification failed:');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} ${violation.name}`);
  }
  console.error(`Use ${ALLOWED_IS_RECORD_FILE} instead of adding local record guards.`);
  process.exitCode = 1;
} else {
  console.log('Shared type guard verification passed.');
}
