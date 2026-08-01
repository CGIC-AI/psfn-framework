#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  isTestSourceFile,
  lineInfoForIndex,
  listTrackedFiles,
  readTextEntriesFromFiles,
  SOURCE_TEXT_EXTENSIONS,
  toPosixPath,
} from './text-scan-utils.mjs';

const SELF_PATH = 'scripts/identity-literal-scan.mjs';
const DEFAULT_ALLOWLIST_PATH = 'config/identity-literal-scan-allowlist.json';
const DEFAULT_SCAN_ROOTS = ['src', 'admin-ui/src', 'scripts'];

const EXCLUDED_PATH_PREFIXES = [
  'dist/',
  '.beads/',
  'data/',
  'logs/',
  'workspace/',
  'history/',
  'node_modules/',
  'admin-ui/node_modules/',
];

export const DEFAULT_PATTERNS = [
  { name: 'identity-proper-name', regex: /\bPSFN\b/g },
  // `psfn-framework-<id>` is the shared bead tracker's namespace; citing a bead
  // ID in a comment is the repo's documented traceability convention, not an
  // identity literal. Without this exemption every lane that cites the bead it
  // implements reddens this scan, which is exactly how main went red on
  // 2026-07-27 (16 of 17 violations were bead citations from four lanes).
  { name: 'identity-legacy-slug', regex: /\bpsfn\b(?!-framework-)/g },
];

/**
 * @typedef {{
 *   path: string;
 *   contains: string;
 *   reason: string;
 *   pattern?: string;
 * }} AllowlistEntry
 */

/**
 * @typedef {{
 *   file: string;
 *   line: number;
 *   column: number;
 *   pattern: string;
 *   snippet: string;
 *   lineText: string;
 * }} IdentityLiteralViolation
 */

/**
 * @param {string} file
 * @param {string[]} roots
 * @returns {boolean}
 */
export function shouldScanFile(file, roots = DEFAULT_SCAN_ROOTS) {
  const normalized = toPosixPath(file);
  if (normalized === SELF_PATH) return false;
  if (normalized.endsWith('.d.ts')) return false;
  if (isTestSourceFile(normalized)) return false;

  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (normalized.startsWith(prefix)) return false;
  }

  const ext = path.extname(normalized).toLowerCase();
  if (!SOURCE_TEXT_EXTENSIONS.has(ext)) return false;

  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

/**
 * @param {AllowlistEntry[]} allowlist
 * @param {IdentityLiteralViolation} violation
 * @returns {AllowlistEntry | null}
 */
function matchAllowlistEntry(allowlist, violation) {
  for (const entry of allowlist) {
    if (entry.path !== violation.file) continue;
    if (entry.pattern && entry.pattern !== violation.pattern) continue;
    if (!violation.lineText.includes(entry.contains)) continue;
    return entry;
  }
  return null;
}

/**
 * @param {Array<{ path: string; text: string }>} entries
 * @param {{
 *   patterns?: Array<{ name: string; regex: RegExp }>;
 *   allowlist?: AllowlistEntry[];
 * }} [options]
 * @returns {{
 *   violations: IdentityLiteralViolation[];
 *   allowlisted: Array<IdentityLiteralViolation & { reason: string }>;
 * }}
 */
export function scanIdentityLiteralEntries(entries, options = {}) {
  const patterns = options.patterns ?? DEFAULT_PATTERNS;
  const allowlist = options.allowlist ?? [];

  /** @type {IdentityLiteralViolation[]} */
  const violations = [];
  /** @type {Array<IdentityLiteralViolation & { reason: string }>} */
  const allowlisted = [];

  for (const entry of entries) {
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(entry.text)) !== null) {
        const info = lineInfoForIndex(entry.text, match.index);
        const violation = {
          file: entry.path,
          line: info.line,
          column: info.column,
          pattern: pattern.name,
          snippet: match[0].slice(0, 80),
          lineText: info.lineText,
        };
        const allowlistEntry = matchAllowlistEntry(allowlist, violation);
        if (allowlistEntry) {
          allowlisted.push({
            ...violation,
            reason: allowlistEntry.reason,
          });
        } else {
          violations.push(violation);
        }
        if (regex.lastIndex === match.index) regex.lastIndex += 1;
      }
    }
  }

  return {
    violations,
    allowlisted,
  };
}

/**
 * @param {string} allowlistPath
 * @returns {AllowlistEntry[]}
 */
export function loadAllowlist(allowlistPath) {
  if (!existsSync(allowlistPath)) return [];
  const raw = readFileSync(allowlistPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.entries)) return [];

  return parsed.entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      path: typeof entry.path === 'string' ? toPosixPath(entry.path.trim()) : '',
      contains: typeof entry.contains === 'string' ? entry.contains : '',
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      ...(typeof entry.pattern === 'string' && entry.pattern.length > 0 ? { pattern: entry.pattern } : {}),
    }))
    .filter((entry) => entry.path.length > 0 && entry.contains.length > 0 && entry.reason.length > 0);
}

/**
 * @param {string[]} trackedFiles
 * @param {string[]} roots
 * @param {{ skipMissing?: boolean }} [options]
 * @returns {Array<{ path: string; text: string }>}
 */
export function readScanEntriesFromFiles(trackedFiles, roots = DEFAULT_SCAN_ROOTS, options = {}) {
  return readTextEntriesFromFiles(
    trackedFiles,
    file => shouldScanFile(file, roots),
    options,
  );
}

/**
 * @param {{ allowlistPath?: string; roots?: string[] }} [options]
 * @returns {{
 *   violations: IdentityLiteralViolation[];
 *   allowlisted: Array<IdentityLiteralViolation & { reason: string }>;
 *   scannedFiles: string[];
 *   allowlistPath: string;
 *   allowlistSize: number;
 * }}
 */
export function scanRepositoryIdentityLiterals(options = {}) {
  const trackedFiles = listTrackedFiles();
  const roots = options.roots ?? DEFAULT_SCAN_ROOTS;
  const allowlistPath = options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH;
  const allowlist = loadAllowlist(allowlistPath);
  const entries = readScanEntriesFromFiles(trackedFiles, roots, { skipMissing: true });

  const result = scanIdentityLiteralEntries(entries, { allowlist });

  return {
    ...result,
    scannedFiles: entries.map((entry) => entry.path),
    allowlistPath,
    allowlistSize: allowlist.length,
  };
}

function main() {
  try {
    const allowlistPath = process.env.IDENTITY_LITERAL_ALLOWLIST?.trim() || DEFAULT_ALLOWLIST_PATH;
    const result = scanRepositoryIdentityLiterals({ allowlistPath });

    if (result.violations.length > 0) {
      console.error('Identity-literal scan failed. Hardcoded identity literals detected:');
      for (const violation of result.violations) {
        console.error(
          `- ${violation.file}:${violation.line}:${violation.column} `
          + `[${violation.pattern}] ${violation.snippet}`,
        );
      }
      console.error(
        `Scanned ${result.scannedFiles.length} files. `
        + `${result.allowlisted.length} hits suppressed by allowlist (${result.allowlistPath}).`,
      );
      process.exit(1);
    }

    console.log(
      `Identity-literal scan passed. Scanned ${result.scannedFiles.length} files with `
      + `${result.allowlisted.length} allowlisted hits (${result.allowlistPath}).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Identity-literal scan failed to complete: ${message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
