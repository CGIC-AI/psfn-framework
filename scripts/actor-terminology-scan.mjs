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

const SELF_PATH = 'scripts/actor-terminology-scan.mjs';
const DEFAULT_BASELINE_PATH = 'config/actor-terminology-baseline.json';
const TEXT_EXTENSIONS = new Set([...SOURCE_TEXT_EXTENSIONS, '.json', '.sh']);

const RETIRED_PATTERNS = [
  { name: 'human-partner', regex: /\bhuman[ \t]+partners?\b/gi },
  { name: 'primary-as-partner', regex: /\b(?:the[ \t]+)?primary[ \t]+(?:users?|persons?|humans?)\b/gi },
  { name: 'hud-operator', regex: /\bHUD[ \t]+operators?\b/gi },
  { name: 'human-approval-role', regex: /\bhuman[ \t]+approval\b|\bthe[ \t]+human[ \t]+raises\b/gi },
];
const RELATIONAL_COPY_PATTERNS = [
  {
    name: 'relational-human',
    regex: /\byour[ \t]+(?:human|person)\b|\bhuman[ \t]+(?:login|authority|attached)\b|\b(?:label|aria-label)=["']Human(?:[ \t]+authority)?["']/gi,
  },
  {
    name: 'relational-operator',
    regex: /\byour[ \t]+operator\b|\b(?:meet(?:ing)?|talk(?:ing)?|chat(?:ting)?|speaking)[ \t]+(?:with[ \t]+)?the[ \t]+operator\b|\bthe[ \t]+operator[ \t]+is[ \t]+(?:travell?ing|waiting|speaking|chatting)\b/gi,
  },
];
const GENERIC_USER_PATTERN = {
  name: 'generic-user',
  // Keep this relational-copy shaped. Protocol values (`role: 'user'`),
  // operating-system users, CSS classes, and identifiers are not copy defects.
  // A primary-user phrase is reported by the more precise pattern above.
  regex: /(?<!primary[ \t])(?:\b(?:the|a|an|your|our|each|every|this|current)[ \t]+users?\b(?!-)|\busers?'s\b|\busers?[- ](?:message|exchange|turn|speech|text|content|flourishing|visible|facing|authored|supplied|provided|switch)\b|\busers?[ \t]+(?:asks?|asked|wants?|needs?|sees?|must|can|may|should|will|has|is|are)\b|\b(?:ask|tell|show|send|reach|support|notify|reply[ \t]+to)[ \t]+(?:the[ \t]+)?users?\b|,[ \t]*users?\b(?=[.!?]))/gi,
};

const GENERIC_USER_COPY_FILES = new Set([
  'config/runtime-prompt-layers.seed.json',
  'src/boundary/gateway/methods/openrouter-web.ts',
  'src/core/agent/no-reply-tool.ts',
  'src/core/agent/substrate-agent/moa-turn.ts',
  'src/core/agent/substrate-agent/turn-execution/agent-invocation.ts',
  'src/core/agent/substrate-agent/vision-attachments.ts',
  'src/core/agent/tool-call-scheduler.ts',
  'src/core/cogsec/intake-firewall-notice-templates.ts',
  'src/core/intention/appraisal/types.ts',
  'src/core/tools/results.ts',
  'src/faculties/file-ingest/document-ingest.ts',
  'src/faculties/memory/episodic/synthesis.ts',
  'src/primitives/images/vision-reviewer.ts',
  'src/shared/contracts/tool-call-outcome.ts',
  'src/system/capabilities/change-notice.ts',
  'src/system/trust/policy.ts',
  'scripts/ops/psfn-compose-smoke-seed.sh',
]);

/**
 * @typedef {{
 *   path: string;
 *   pattern: string;
 *   contains: string;
 *   note: string;
 * }} TerminologyBaselineEntry
 */

/**
 * @typedef {{
 *   file: string;
 *   line: number;
 *   column: number;
 *   pattern: string;
 *   snippet: string;
 *   lineText: string;
 * }} TerminologyViolation
 */

/**
 * @param {string} file
 * @returns {boolean}
 */
export function shouldScanActorTerminologyFile(file) {
  const normalized = toPosixPath(file);
  if (normalized === SELF_PATH || normalized.endsWith('.d.ts') || isTestSourceFile(normalized)) return false;
  if (!TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return false;

  return normalized === 'README.md'
    || normalized === 'config/runtime-prompt-layers.seed.json'
    || normalized.startsWith('docs/')
    || normalized.startsWith('src/')
    || normalized.startsWith('scripts/')
    || normalized.startsWith('admin-ui/src/')
    || normalized.startsWith('companion-ui/src/')
    || normalized === 'companion-ui/README.md'
    || normalized === 'companion-ui/SHARD_APPROVALS.md';
}

/** @param {string} file */
function isGenericUserCopySurface(file) {
  if (file === 'README.md' || file.startsWith('docs/')) return true;
  if (file.startsWith('companion-ui/')) return true;
  if (file.startsWith('src/core/identity/')) return true;
  if (file.startsWith('src/core/agent/tool-surface/descriptions/')) return true;
  if (file === 'src/channels/api/server/companion-touch-stimulus-route.ts') return true;
  if (GENERIC_USER_COPY_FILES.has(file)) return true;

  const basename = path.posix.basename(file);
  return file.startsWith('src/')
    && /^(?:prompt|prompts|tools|system-language-contracts|macro-hints)\.[cm]?[jt]sx?$/.test(basename);
}

/** @param {unknown[]} baseline */
function validateBaseline(baseline) {
  return baseline.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`baseline entry ${index + 1} must be an object`);
    }
    const candidate = /** @type {Record<string, unknown>} */ (entry);
    for (const field of ['path', 'pattern', 'contains', 'note']) {
      if (typeof candidate[field] !== 'string' || candidate[field].trim().length === 0) {
        throw new Error(`baseline entry ${index + 1} requires a non-empty ${field}`);
      }
    }
    return /** @type {TerminologyBaselineEntry} */ ({
      path: toPosixPath(/** @type {string} */ (candidate.path).trim()),
      pattern: /** @type {string} */ (candidate.pattern).trim(),
      contains: /** @type {string} */ (candidate.contains),
      note: /** @type {string} */ (candidate.note).trim(),
    });
  });
}

/**
 * @param {string} baselinePath
 * @returns {TerminologyBaselineEntry[]}
 */
export function loadActorTerminologyBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    throw new Error(`baseline file is missing: ${baselinePath}`);
  }
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new Error(`baseline file must contain an entries array: ${baselinePath}`);
  }
  return validateBaseline(parsed.entries);
}

/**
 * @param {Array<{ path: string; text: string }>} entries
 * @param {{ baseline?: TerminologyBaselineEntry[] }} [options]
 */
export function scanActorTerminologyEntries(entries, options = {}) {
  const baseline = validateBaseline(options.baseline ?? []);
  const matchedBaseline = new Set();
  /** @type {TerminologyViolation[]} */
  const violations = [];
  /** @type {Array<TerminologyViolation & { note: string }>} */
  const baselined = [];

  for (const entry of entries) {
    const normalizedPath = toPosixPath(entry.path);
    const patterns = isGenericUserCopySurface(normalizedPath)
      ? [...RETIRED_PATTERNS, ...RELATIONAL_COPY_PATTERNS, GENERIC_USER_PATTERN]
      : RETIRED_PATTERNS;

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(entry.text)) !== null) {
        const info = lineInfoForIndex(entry.text, match.index);
        const violation = {
          file: normalizedPath,
          line: info.line,
          column: info.column,
          pattern: pattern.name,
          snippet: match[0],
          lineText: info.lineText,
        };
        const accepted = baseline.find(candidate => !matchedBaseline.has(candidate)
          && candidate.path === violation.file
          && candidate.pattern === violation.pattern
          && violation.lineText.includes(candidate.contains));
        if (accepted) {
          matchedBaseline.add(accepted);
          baselined.push({ ...violation, note: accepted.note });
        } else {
          violations.push(violation);
        }
        if (regex.lastIndex === match.index) regex.lastIndex += 1;
      }
    }
  }

  return {
    violations,
    baselined,
    staleBaseline: baseline.filter(entry => !matchedBaseline.has(entry)),
  };
}

/** @param {string[]} trackedFiles */
function readTrackedEntries(trackedFiles) {
  return readTextEntriesFromFiles(trackedFiles, shouldScanActorTerminologyFile, {
    skipMissing: true,
  });
}

/** @param {{ baselinePath?: string }} [options] */
export function scanRepositoryActorTerminology(options = {}) {
  const baselinePath = options.baselinePath ?? DEFAULT_BASELINE_PATH;
  const trackedFiles = listTrackedFiles();
  const entries = readTrackedEntries(trackedFiles);
  return {
    ...scanActorTerminologyEntries(entries, {
      baseline: loadActorTerminologyBaseline(baselinePath),
    }),
    baselinePath,
    scannedFiles: entries.map(entry => entry.path),
  };
}

function main() {
  try {
    const baselinePath = process.env.ACTOR_TERMINOLOGY_BASELINE?.trim() || DEFAULT_BASELINE_PATH;
    const result = scanRepositoryActorTerminology({ baselinePath });
    if (result.violations.length > 0 || result.staleBaseline.length > 0) {
      console.error('Actor terminology scan failed.');
      for (const violation of result.violations) {
        console.error(
          `- ${violation.file}:${violation.line}:${violation.column} `
          + `[${violation.pattern}] ${violation.snippet}`,
        );
      }
      for (const stale of result.staleBaseline) {
        console.error(`- stale baseline: ${stale.path} [${stale.pattern}] ${stale.contains}`);
      }
      console.error(
        `Scanned ${result.scannedFiles.length} files with ${result.baselined.length} noted exceptions `
        + `(${result.baselinePath}).`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Actor terminology scan passed. Scanned ${result.scannedFiles.length} files with `
      + `${result.baselined.length} noted exceptions (${result.baselinePath}).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Actor terminology scan failed to complete: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
