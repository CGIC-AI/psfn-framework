#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SELF_PATH = 'scripts/public-sanitize-check.mjs';
export const DEFAULT_LOCAL_BLOCKLIST_PATH = 'workspace/sanitize/local-blocklist.json';

// Beads history logs are machine-managed workspace artifacts, not public source/docs.
const MACHINE_MANAGED_BEADS_HISTORY_FILES = new Set([
  'daemon.log',
  'issues.jsonl',
  'beads.left.jsonl',
  'interactions.jsonl',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.woff', '.woff2',
]);

const FORBIDDEN_PATH_RULES = [
  {
    name: 'character-card-artifact',
    test: (file) => /(^|\/)(character\.json|.*\.charx)$/i.test(file),
  },
];

const TEXT_RULES = [
  { name: 'token-telegram', regex: /\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g },
  { name: 'token-openai-like', regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'token-github-pat', regex: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: 'token-google-api-key', regex: /\bAIza[0-9A-Za-z\-_]{20,}\b/g },
  {
    name: 'token-discord-bot',
    regex: /\b(?:mfa\.)?[A-Za-z\d_-]{24}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27}\b/g,
  },
];

/** @param {string} maybePath */
function toPosixRelativePath(maybePath) {
  return maybePath.split(path.sep).join('/');
}

function resolveLocalBlocklistPath() {
  const configured = process.env.PUBLIC_SANITIZE_LOCAL_BLOCKLIST?.trim();
  if (!configured) return DEFAULT_LOCAL_BLOCKLIST_PATH;
  return path.isAbsolute(configured) ? configured : path.resolve(configured);
}

export function loadLocalBlocklist() {
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

/** @param {string} file */
export function shouldSkipTrackedFile(file) {
  const normalized = toPosixRelativePath(file);
  if (normalized === SELF_PATH) return true;
  if (!normalized.startsWith('.beads/')) return false;
  const basename = path.posix.basename(normalized);
  return MACHINE_MANAGED_BEADS_HISTORY_FILES.has(basename);
}

/** @param {string} file */
export function shouldScanTextContent(file) {
  const normalized = toPosixRelativePath(file);
  if (shouldSkipTrackedFile(normalized)) return false;
  const ext = path.extname(normalized).toLowerCase();
  return !BINARY_EXTENSIONS.has(ext);
}

/** @param {string} text @param {number} idx */
function lineForIndex(text, idx) {
  let line = 1;
  for (let i = 0; i < idx; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** @type {Array<{file:string, line:number, rule:string, snippet:string}>} */
function collectTextViolations(file, text, rules) {
  /** @type {Array<{file:string, line:number, rule:string, snippet:string}>} */
  const violations = [];
  for (const rule of rules) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const line = lineForIndex(text, match.index);
      const snippet = match[0].slice(0, 80);
      violations.push({ file, line, rule: rule.name, snippet });
      if (regex.lastIndex === match.index) regex.lastIndex += 1;
    }
  }
  return violations;
}

/** @returns {string[]} */
function listTrackedFiles() {
  return execSync('git ls-files -z', { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((file) => toPosixRelativePath(file));
}

/**
 * @param {string[]} trackedFiles
 * @param {{
 *   localBlocklist?: {
 *     localPath: string;
 *     forbiddenPathRegex: Array<{name:string, regex:RegExp}>;
 *     textRuleRegex: Array<{name:string, regex:RegExp}>;
 *     loaded: boolean;
 *   };
 *   readTextFile?: (file: string) => string;
 * }} [options]
 */
export function scanPublicSanitizeTrackedFiles(trackedFiles, options = {}) {
  const localBlocklist = options.localBlocklist ?? loadLocalBlocklist();
  const readTextFile = options.readTextFile ?? ((file) => readFileSync(file, 'utf8'));

  /** @type {Array<{file:string, line:number, rule:string, snippet:string}>} */
  const violations = [];

  for (const trackedFile of trackedFiles.map((file) => toPosixRelativePath(file))) {
    if (shouldSkipTrackedFile(trackedFile)) {
      continue;
    }

    for (const rule of FORBIDDEN_PATH_RULES) {
      if (rule.test(trackedFile)) {
        violations.push({ file: trackedFile, line: 1, rule: rule.name, snippet: trackedFile });
      }
    }
    for (const localRule of localBlocklist.forbiddenPathRegex) {
      if (localRule.regex.test(trackedFile)) {
        violations.push({ file: trackedFile, line: 1, rule: localRule.name, snippet: trackedFile });
      }
    }

    if (!shouldScanTextContent(trackedFile)) {
      continue;
    }

    const text = readTextFile(trackedFile);
    violations.push(...collectTextViolations(trackedFile, text, TEXT_RULES));
    violations.push(...collectTextViolations(trackedFile, text, localBlocklist.textRuleRegex));
  }

  return {
    violations,
    localBlocklist,
  };
}

export function scanRepositoryPublicSanitize() {
  const trackedFiles = listTrackedFiles();
  const result = scanPublicSanitizeTrackedFiles(trackedFiles);
  return {
    ...result,
    trackedFileCount: trackedFiles.length,
  };
}

function main() {
  try {
    const result = scanRepositoryPublicSanitize();
    if (result.violations.length > 0) {
      console.error('Public-sanitize check failed. Violations found:');
      for (const violation of result.violations) {
        console.error(`- ${violation.file}:${violation.line} [${violation.rule}] ${violation.snippet}`);
      }
      process.exit(1);
    }

    console.log('Public-sanitize check passed. No blocked PII/story/token patterns found.');
    if (result.localBlocklist.loaded) {
      console.log(`Local blocklist loaded from ${result.localBlocklist.localPath}`);
    } else {
      console.log(`No local blocklist found at ${result.localBlocklist.localPath} (generic checks only).`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Public-sanitize check failed to complete: ${message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
