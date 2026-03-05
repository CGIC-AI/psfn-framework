#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const tracked = execSync('git ls-files -z', { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const SELF_PATH = 'scripts/public-sanitize-check.mjs';
const DEFAULT_LOCAL_BLOCKLIST_PATH = 'workspace/sanitize/local-blocklist.json';

const binaryExt = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.woff', '.woff2',
]);

const forbiddenPathRules = [
  {
    name: 'character-card-artifact',
    test: (file) => /(^|\/)(character\.json|.*\.charx)$/i.test(file),
  },
];

const textRules = [
  { name: 'token-telegram', regex: /\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g },
  { name: 'token-openai-like', regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'token-github-pat', regex: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: 'token-google-api-key', regex: /\bAIza[0-9A-Za-z\-_]{20,}\b/g },
  {
    name: 'token-discord-bot',
    regex: /\b(?:mfa\.)?[A-Za-z\d_-]{24}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27}\b/g,
  },
];

function resolveLocalBlocklistPath() {
  const configured = process.env.PUBLIC_SANITIZE_LOCAL_BLOCKLIST?.trim();
  if (!configured) return DEFAULT_LOCAL_BLOCKLIST_PATH;
  return path.isAbsolute(configured) ? configured : path.resolve(configured);
}

function loadLocalBlocklist() {
  const localPath = resolveLocalBlocklistPath();
  if (!existsSync(localPath)) {
    return {
      localPath,
      forbiddenPathRegex: [],
      textRuleRegex: [],
      loaded: false,
    };
  }
  const raw = readFileSync(localPath, 'utf8');
  const parsed = JSON.parse(raw);
  const forbiddenPathRegex = Array.isArray(parsed.forbiddenPathRegex)
    ? parsed.forbiddenPathRegex
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .map((pattern, index) => ({ name: `local-path-${index + 1}`, regex: new RegExp(pattern, 'i') }))
    : [];
  const textRuleRegex = Array.isArray(parsed.textRegex)
    ? parsed.textRegex
      .map((entry, index) => {
        if (typeof entry === 'string') {
          return { name: `local-text-${index + 1}`, regex: new RegExp(entry, 'gi') };
        }
        if (entry && typeof entry.pattern === 'string' && entry.pattern.trim().length > 0) {
          const flags = typeof entry.flags === 'string' && entry.flags.length > 0 ? entry.flags : 'gi';
          const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : `local-text-${index + 1}`;
          return { name, regex: new RegExp(entry.pattern, flags) };
        }
        return null;
      })
      .filter(Boolean)
    : [];
  return {
    localPath,
    forbiddenPathRegex,
    textRuleRegex,
    loaded: true,
  };
}

const localBlocklist = loadLocalBlocklist();

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
  // Avoid matching this scanner's own regex literals.
  if (file === SELF_PATH) continue;

  for (const rule of forbiddenPathRules) {
    if (rule.test(file)) {
      violations.push({ file, line: 1, rule: rule.name, snippet: file });
    }
  }
  for (const localRule of localBlocklist.forbiddenPathRegex) {
    if (localRule.regex.test(file)) {
      violations.push({ file, line: 1, rule: localRule.name, snippet: file });
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
  for (const rule of localBlocklist.textRuleRegex) {
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
if (localBlocklist.loaded) {
  console.log(`Local blocklist loaded from ${localBlocklist.localPath}`);
} else {
  console.log(`No local blocklist found at ${localBlocklist.localPath} (generic checks only).`);
}
