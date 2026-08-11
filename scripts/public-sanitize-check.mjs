#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SELF_PATH = 'scripts/public-sanitize-check.mjs';
export const DEFAULT_LOCAL_BLOCKLIST_PATH = 'workspace/sanitize/local-blocklist.json';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.woff', '.woff2',
]);

const SOURCE_CODE_EXTENSIONS = new Set([
  '.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.sh', '.ts', '.tsx',
]);

const FORBIDDEN_PATH_RULES = [
  {
    name: 'local-only-repository-surface',
    test: (file) => /^(?:\.beads|working_docs|deploy|deployment|shakedown|\.agents|\.claude|\.codec|\.codex|\.cursor|\.gemini)(?:\/|$)/i.test(file),
  },
  {
    name: 'private-deployment-config',
    test: (file) => file === '.trivyignore.yaml' || file === '.github/workflows/trivy-config.yml',
  },
  {
    name: 'character-card-artifact',
    test: (file) => /(^|\/)(character\.json|.*\.charx)$/i.test(file),
  },
  {
    name: 'tracked-session-archive',
    test: (file) => /^working_docs\/.*(?:session|transcript).*\.(?:zip|tar|gz|7z)$/i.test(file),
  },
  {
    name: 'tracked-beads-runtime-log',
    test: (file) => /^\.beads\/.*\.log$/i.test(file),
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
  { name: 'tailnet-address', regex: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}\b(?!\/)/g },
  {
    name: 'private-ipv4-address',
    regex: /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/g,
  },
  { name: 'internal-local-hostname', regex: /\b[a-z0-9.-]+\.local\.internal\b/gi },
  {
    name: 'live-hardware-uuid',
    regex: /\buuid:\s*[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi,
  },
];

/** @param {string} maybePath */
function toPosixRelativePath(maybePath) {
  return maybePath.split(path.sep).join('/');
}

function resolveLocalBlocklistPath() {
  const configured = process.env.PUBLIC_SANITIZE_LOCAL_BLOCKLIST?.trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.resolve(configured);
  let repositoryConfigured = '';
  try {
    repositoryConfigured = execFileSync('git', ['config', '--get', 'publicSanitize.localBlocklist'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 1) {
      throw error;
    }
    // Git status 1 is the documented no-value result and the normal public-CI case.
  }
  if (!repositoryConfigured) return DEFAULT_LOCAL_BLOCKLIST_PATH;
  return path.isAbsolute(repositoryConfigured)
    ? repositoryConfigured
    : path.resolve(repositoryConfigured);
}

export function loadLocalBlocklist({
  required = process.env.PUBLIC_SANITIZE_REQUIRE_LOCAL_BLOCKLIST === '1',
} = {}) {
  const localPath = resolveLocalBlocklistPath();
  if (!existsSync(localPath)) {
    if (required) {
      throw new Error(
        'Required local privacy blocklist is missing. Set PUBLIC_SANITIZE_LOCAL_BLOCKLIST '
        + 'to an external file or create the ignored workspace/sanitize/local-blocklist.json.',
      );
    }
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
  return normalized === SELF_PATH;
}

/** @param {string} file */
export function shouldScanTextContent(file) {
  const normalized = toPosixRelativePath(file);
  if (shouldSkipTrackedFile(normalized)) return false;
  const ext = path.extname(normalized).toLowerCase();
  return !BINARY_EXTENSIONS.has(ext);
}

/** @param {string} file */
export function shouldScanSourceForNulByte(file) {
  const normalized = toPosixRelativePath(file);
  return SOURCE_CODE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
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

function textRulesForFile(file) {
  if (/\.(?:test|spec)\.[^.]+$/i.test(file) || /(?:^|\/)corpus(?:\/|$)/i.test(file)) {
    return TEXT_RULES.filter((rule) => rule.name !== 'private-ipv4-address');
  }
  return TEXT_RULES;
}

/** @returns {Array<{file:string, line:number, rule:string, snippet:string}>} */
function collectNulByteViolations(file, text) {
  /** @type {Array<{file:string, line:number, rule:string, snippet:string}>} */
  const violations = [];
  let index = text.indexOf('\0');
  while (index !== -1) {
    violations.push({
      file,
      line: lineForIndex(text, index),
      rule: 'literal-nul-byte',
      snippet: 'U+0000 (NUL)',
    });
    index = text.indexOf('\0', index + 1);
  }
  return violations;
}

/** @returns {string[]} */
export function parseTrackedFilesFromGitLsStage(raw) {
  return raw
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const pathSeparatorIndex = entry.indexOf('\t');
      if (pathSeparatorIndex === -1) {
        throw new Error(`Malformed git ls-files --stage entry: ${entry}`);
      }
      const [mode] = entry.slice(0, pathSeparatorIndex).split(' ');
      if (mode === '160000') {
        return null;
      }
      return toPosixRelativePath(entry.slice(pathSeparatorIndex + 1));
    })
    .filter((file) => file !== null);
}

/** @returns {string[]} */
function listTrackedFiles() {
  return parseTrackedFilesFromGitLsStage(
    execSync('git ls-files --stage -z', { encoding: 'utf8' }),
  );
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
  const skipMissingWorkingTreeFiles = options.readTextFile === undefined;

  /** @type {Array<{file:string, line:number, rule:string, snippet:string}>} */
  const violations = [];

  for (const trackedFile of trackedFiles.map((file) => toPosixRelativePath(file))) {
    let sourceText;
    if (
      shouldScanSourceForNulByte(trackedFile)
      && (!skipMissingWorkingTreeFiles || existsSync(trackedFile))
    ) {
      sourceText = readTextFile(trackedFile);
      violations.push(...collectNulByteViolations(trackedFile, sourceText));
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

    if (shouldSkipTrackedFile(trackedFile)) {
      continue;
    }

    if (!shouldScanTextContent(trackedFile)) {
      continue;
    }

    if (skipMissingWorkingTreeFiles && !existsSync(trackedFile)) {
      continue;
    }
    const text = sourceText ?? readTextFile(trackedFile);
    violations.push(...collectTextViolations(trackedFile, text, textRulesForFile(trackedFile)));
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
        console.error(`- ${violation.file}:${violation.line} [${violation.rule}]`);
      }
      process.exit(1);
    }

    console.log('Public-sanitize check passed. No blocked patterns found.');
    if (result.localBlocklist.loaded) {
      console.log('Local privacy blocklist loaded.');
    } else {
      console.log('No local privacy blocklist configured (generic checks only).');
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
