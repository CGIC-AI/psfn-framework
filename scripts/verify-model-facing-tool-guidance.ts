#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  listRetiredToolAliases,
  type RetiredToolAlias,
} from '../src/core/agent/tool-surface/registry.js';

const GUIDANCE_PATHS = [
  'README.md',
  'docs',
  'skills',
  'companion_docs',
  'resources/companion-library',
  'config/runtime-prompt-layers.seed.json',
] as const;

export interface ModelFacingGuidanceEntry {
  path: string;
  text: string;
}

export interface RetiredAliasGuidanceViolation {
  path: string;
  line: number;
  alias: string;
  canonicalName: string;
  lineText: string;
}

type RetiredAliasAuthorityEntry = Pick<
  RetiredToolAlias,
  'alias' | 'canonicalName' | 'replacementAction'
>;

export function validateRetiredAliasAuthority(
  entries: readonly RetiredAliasAuthorityEntry[],
): ReadonlyMap<string, RetiredAliasAuthorityEntry> {
  if (entries.length === 0) {
    throw new Error('Canonical retired tool alias authority must not be empty');
  }
  const authority = new Map<string, RetiredAliasAuthorityEntry>();
  for (const entry of entries) {
    if (!entry.alias.trim() || !entry.canonicalName.trim() || entry.alias === entry.canonicalName) {
      throw new Error('Canonical retired tool alias authority contains malformed metadata');
    }
    if (authority.has(entry.alias)) {
      throw new Error(`Canonical retired tool alias authority contains duplicate retired alias: ${entry.alias}`);
    }
    authority.set(entry.alias, entry);
  }
  return authority;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function presentsAliasAsCallable(line: string, alias: string): boolean {
  const escaped = escapeRegExp(alias);
  if (new RegExp(`\`${escaped}\``, 'u').test(line)) return true;
  if (new RegExp(`(?:"|')${escaped}(?:"|')`, 'u').test(line)) return true;
  return new RegExp(
    `\\b(?:use|call|invoke|run|execute|prefer|load|activate)\\b[^\\n]{0,100}(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`,
    'iu',
  ).test(line);
}

function presentsAliasAsCanonicalAction(
  line: string,
  alias: RetiredAliasAuthorityEntry,
): boolean {
  if (alias.replacementAction !== alias.alias) return false;
  const escaped = escapeRegExp(alias.alias);
  if (new RegExp(`\\baction\\s*=\\s*["']${escaped}["']`, 'u').test(line)) return true;
  return line.includes(`\`${alias.canonicalName}\``)
    && /\bactions?\b/iu.test(line)
    && new RegExp(`\`${escaped}\``, 'u').test(line);
}

/**
 * Narrow, auditable exceptions for text whose purpose is to record retired
 * names rather than instruct the model to call them.
 */
function isDocumentedRetiredAliasContext(path: string, line: string): boolean {
  if (path === 'docs/tool-surface.md') {
    return /^\s*\|/u.test(line)
      || line.includes('->')
      || /^\s*- Primary actions:/u.test(line)
      || /\b(?:retired|historical|legacy|formerly|no longer live|not model-facing|must not be model-facing|must not be used)\b/iu.test(line)
      || /REPL-only.+(?:helper|tool-catalog)/iu.test(line)
      || /OpenRouter.+server tool/iu.test(line);
  }
  if (path === 'docs/cognitive-security.md') {
    return /^\s*\|/u.test(line)
      || !/\b(?:use|call|invoke|run|execute|prefer|load|activate)\b/iu.test(line);
  }
  if (path === 'docs/PSFN_PROJECT_CHARTER.md') {
    return /\b(?:retired|historical|legacy|not (?:a )?(?:separate )?model-facing tools?|must not remain callable)\b/iu.test(line);
  }
  return false;
}

export function scanModelFacingToolGuidanceEntries(
  entries: readonly ModelFacingGuidanceEntry[],
  retiredAliases: readonly RetiredAliasAuthorityEntry[] = listRetiredToolAliases(),
): { violations: RetiredAliasGuidanceViolation[] } {
  const authority = validateRetiredAliasAuthority(retiredAliases);
  const violations: RetiredAliasGuidanceViolation[] = [];
  for (const entry of entries) {
    const path = entry.path.replaceAll('\\', '/');
    for (const [lineIndex, lineText] of entry.text.split(/\r?\n/u).entries()) {
      if (isDocumentedRetiredAliasContext(path, lineText)) continue;
      for (const alias of authority.values()) {
        if (!presentsAliasAsCallable(lineText, alias.alias)) continue;
        if (presentsAliasAsCanonicalAction(lineText, alias)) continue;
        violations.push({
          path,
          line: lineIndex + 1,
          alias: alias.alias,
          canonicalName: alias.canonicalName,
          lineText,
        });
      }
    }
  }
  return { violations };
}

export function scanRepositoryModelFacingToolGuidance(): {
  violations: RetiredAliasGuidanceViolation[];
} {
  const trackedFiles = execFileSync('git', ['ls-files', '--', ...GUIDANCE_PATHS], {
    encoding: 'utf8',
  })
    .split(/\r?\n/u)
    .map(path => path.trim())
    .filter(Boolean);
  return scanModelFacingToolGuidanceEntries(trackedFiles.map(path => ({
    path,
    text: readFileSync(path, 'utf8'),
  })));
}

function main(): void {
  const result = scanRepositoryModelFacingToolGuidance();
  if (result.violations.length === 0) {
    process.stdout.write('Model-facing tool guidance uses canonical tool names and actions.\n');
    return;
  }
  process.stderr.write('Retired tool aliases presented as callable model-facing guidance:\n');
  for (const violation of result.violations) {
    process.stderr.write(
      `- ${violation.path}:${violation.line} ${violation.alias}->${violation.canonicalName}: ${violation.lineText.trim()}\n`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
