#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SELF_PATH = 'scripts/verify-actor-terminology.mjs';
const DEFAULT_SCAN_ROOTS = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'docs',
  'companion_docs',
  'companion-ui',
  'skills',
  'config/runtime-prompt-layers.seed.json',
  'deploy',
  'deployment',
  'k8s',
  'models',
  'src',
  'admin-ui/src',
  'working_docs/public-release-post-draft.md',
  'working_docs/public-roadmap-draft.md',
];

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
  '.html',
  '.json',
  '.md',
  '.mmd',
]);

export const ACTOR_TERMINOLOGY_PATTERNS = [
  { name: 'primary-as-person', regex: /\bprimary\s+(?:user|person)\b/gi },
  { name: 'redundant-human-partner', regex: /\bhuman\s+partner\b/gi },
  { name: 'hud-operator-as-partner', regex: /\bHUD\s+operator\b/gi },
];

const LEGACY_INPUT_ALLOWLIST = [
  {
    path: 'src/faculties/memory/extraction/naming.ts',
    contains: "  'primary user',",
    reason: 'Recognizes and repairs a legacy generated-memory placeholder.',
  },
  {
    path: 'src/faculties/memory/extraction/naming.ts',
    contains: "  'the primary user',",
    reason: 'Recognizes and repairs a legacy generated-memory placeholder.',
  },
  {
    path: 'src/faculties/memory/extraction/naming.ts',
    contains: "  { pattern: /\\bthe primary user's\\b/gi, possessive: true },",
    reason: 'Recognizes and repairs a legacy generated-memory placeholder.',
  },
  {
    path: 'src/faculties/memory/extraction/naming.ts',
    contains: '  { pattern: /\\bthe primary user\\b(?!-)/gi, possessive: false, skipOrdinaryNounFollower: true },',
    reason: 'Recognizes and repairs a legacy generated-memory placeholder.',
  },
  {
    path: 'src/persistence/repair/memory-participant-name-repair.ts',
    contains: "  OR lower(text) LIKE '%primary user%'",
    reason: 'Matches historical persisted text during the explicit repair command.',
  },
];

function normalizedPath(file) {
  return file.split(path.sep).join('/');
}

function isTestOrFixture(file) {
  return /(?:^|\/)(?:test-fixtures|__tests__|e2e)(?:\/|$)/i.test(file)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file);
}

export function shouldScanActorTerminologyFile(file, roots = DEFAULT_SCAN_ROOTS) {
  const normalized = normalizedPath(file);
  if (normalized === SELF_PATH || isTestOrFixture(normalized)) return false;
  if (!TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return false;
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function allowlistEntryFor(file, lineText) {
  return LEGACY_INPUT_ALLOWLIST.find(
    (entry) => entry.path === file && lineText.includes(entry.contains),
  );
}

export function scanActorTerminologyEntries(entries) {
  const violations = [];
  const allowlisted = [];
  const usedAllowlist = new Set();

  for (const entry of entries) {
    const lines = entry.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index];
      for (const pattern of ACTOR_TERMINOLOGY_PATTERNS) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        for (const match of lineText.matchAll(regex)) {
          const finding = {
            file: entry.path,
            line: index + 1,
            column: (match.index ?? 0) + 1,
            pattern: pattern.name,
            snippet: match[0],
            lineText,
          };
          const allowed = allowlistEntryFor(entry.path, lineText);
          if (allowed) {
            allowlisted.push({ ...finding, reason: allowed.reason });
            usedAllowlist.add(`${allowed.path}\0${allowed.contains}`);
          } else {
            violations.push(finding);
          }
        }
      }
    }
  }

  const scannedPaths = new Set(entries.map((entry) => entry.path));
  const staleAllowlist = LEGACY_INPUT_ALLOWLIST.filter(
    (entry) => scannedPaths.has(entry.path)
      && !usedAllowlist.has(`${entry.path}\0${entry.contains}`),
  );

  return { violations, allowlisted, staleAllowlist };
}

export function scanRepositoryActorTerminology() {
  const trackedAndUntracked = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  ).split('\0').filter(Boolean).map(normalizedPath);

  const files = [...new Set(trackedAndUntracked)]
    .filter((file) => shouldScanActorTerminologyFile(file))
    .filter((file) => existsSync(file));
  const entries = files.map((file) => ({
    path: file,
    text: readFileSync(file, 'utf8'),
  }));

  return { ...scanActorTerminologyEntries(entries), scannedFiles: files };
}

function main() {
  try {
    const result = scanRepositoryActorTerminology();
    if (result.violations.length > 0 || result.staleAllowlist.length > 0) {
      console.error('Actor-terminology verification failed.');
      for (const finding of result.violations) {
        console.error(
          `- ${finding.file}:${finding.line}:${finding.column} `
          + `[${finding.pattern}] ${finding.snippet}`,
        );
      }
      for (const entry of result.staleAllowlist) {
        console.error(`- stale legacy-input allowance: ${entry.path} :: ${entry.contains}`);
      }
      process.exit(1);
    }

    console.log(
      `Actor-terminology verification passed. Scanned ${result.scannedFiles.length} files; `
      + `${result.allowlisted.length} legacy-input recognizers allowed.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Actor-terminology verification failed to complete: ${message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
