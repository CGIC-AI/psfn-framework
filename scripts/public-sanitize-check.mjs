#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const tracked = execSync('git ls-files -z', { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const binaryExt = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.woff', '.woff2',
]);

const forbiddenPathRules = [
  {
    name: 'personal-story-doc',
    test: (file) => file === 'docs/A Day with Purrsephone- A Love Story in Code and Care.md',
  },
  {
    name: 'character-card-artifact',
    test: (file) => /(^|\/)(purrsephone\.json|.*\.charx)$/i.test(file),
  },
];

const textRules = [
  { name: 'pii-name-vega', regex: /\bVega\b/g },
  { name: 'pii-handle-vega', regex: /@vega\b/gi },
  { name: 'pii-lower-vega', regex: /\bvega\b/g },
  { name: 'personal-story-title', regex: /A Day with Purrsephone|Love Story in Code and Care/g },
  { name: 'token-telegram', regex: /\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g },
  { name: 'token-openai-like', regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'token-github-pat', regex: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: 'token-google-api-key', regex: /\bAIza[0-9A-Za-z\-_]{20,}\b/g },
  {
    name: 'token-discord-bot',
    regex: /\b(?:mfa\.)?[A-Za-z\d_-]{24}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27}\b/g,
  },
];

/** @param {string} text @param {number} idx */
function lineForIndex(text, idx) {
  let line = 1;
  for (let i = 0; i < idx; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** @type {Array<{file:string, line:number, rule:string, snippet:string}>} */
const violations = [];

for (const file of tracked) {
  for (const rule of forbiddenPathRules) {
    if (rule.test(file)) {
      violations.push({ file, line: 1, rule: rule.name, snippet: file });
    }
  }

  const ext = path.extname(file).toLowerCase();
  if (binaryExt.has(ext)) continue;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const rule of textRules) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const line = lineForIndex(text, match.index);
      const snippet = match[0].slice(0, 80);
      violations.push({ file, line, rule: rule.name, snippet });
      if (regex.lastIndex === match.index) regex.lastIndex += 1;
    }
  }
}

if (violations.length > 0) {
  console.error('Public-sanitize check failed. Violations found:');
  for (const v of violations) {
    console.error(`- ${v.file}:${v.line} [${v.rule}] ${v.snippet}`);
  }
  process.exit(1);
}

console.log('Public-sanitize check passed. No blocked PII/story/token patterns found.');
