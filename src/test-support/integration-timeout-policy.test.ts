import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scanFileForTimeoutOverrides,
  scanSourceForTimeoutOverrides,
  type FileOverrideScan,
} from './integration-timeout-scan.js';

/**
 * Timeout-margin policy enforcement.
 *
 * Every explicit vitest timeout override in an `*.integration.test.ts` file must
 * be registered in `integration-timeout-registry.json`. The scanner
 * (`integration-timeout-scan.ts`) parses each file's AST and surfaces the
 * distinct timeout values it uses; this convention test checks those against the
 * registry and fails closed on any override that is not registered.
 *
 * Two registration tiers:
 *   - `measured`  — carries a real measured baseline; the timeout must clear the
 *     policy headroom ratio (`timeoutMs >= minHeadroomRatio * measuredBaselineMs`).
 *   - `inherited` — a pre-policy override captured as measurement debt. It has no
 *     independently measured baseline (`measuredBaselineMs: null`) but is pinned
 *     to its exact value, so any change to the timeout breaks this test and forces
 *     a registry update (and the opportunity to measure a real baseline).
 */

const REPO_ROOT = process.cwd();
const REGISTRY_PATH = join(REPO_ROOT, 'src', 'test-support', 'integration-timeout-registry.json');
const INTEGRATION_SUFFIX = '.integration.test.ts';

// The registry is untrusted JSON on disk: type the parsed fields loosely so the
// well-formedness checks below are genuine runtime validation, not TypeScript
// tautologies the linter would (correctly) flag as unnecessary.
interface RegistryEntry {
  file: string;
  timeoutMs: number;
  measuredBaselineMs: number | null;
  baselineSource: string;
  note: string;
}

interface Registry {
  policy: {
    minHeadroomRatio: number;
    globalDefaultTimeoutMs: number;
    description: string;
  };
  overrides: RegistryEntry[];
}

function discoverIntegrationTestFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(INTEGRATION_SUFFIX)) {
        found.push(relative(REPO_ROOT, full).split(sep).join('/'));
      }
    }
  };
  walk(join(REPO_ROOT, 'src'));
  return found.sort();
}

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
const files = discoverIntegrationTestFiles();
const scans: FileOverrideScan[] = files.map(rel =>
  scanFileForTimeoutOverrides(rel, join(REPO_ROOT, rel)),
);

const registryByKey = new Map<string, RegistryEntry>();
for (const entry of registry.overrides) {
  registryByKey.set(`${entry.file}::${entry.timeoutMs}`, entry);
}

describe('integration timeout override policy', () => {
  it('flags dynamic timeout expressions without false-positives on option objects', () => {
    const scan = scanSourceForTimeoutOverrides(
      'synthetic.integration.test.ts',
      [
        "it('dynamic', { timeout: getRestoreTimeout() }, () => {});",
        "it('options without timeout', { retry: 2 }, () => {});",
        "it('static', () => {}, 120_000);",
      ].join('\n'),
    );
    expect(scan.unresolvedSites).toHaveLength(1);
    expect(scan.unresolvedSites[0]?.expression).toBe('getRestoreTimeout()');
    expect(scan.sites.map(site => site.timeoutMs)).toEqual([120_000]);
  });

  it('rejects dynamic timeout expressions the scanner cannot resolve', () => {
    const unresolved: string[] = [];
    for (const scan of scans) {
      for (const site of scan.unresolvedSites) {
        unresolved.push(`${scan.file}:${site.line} ${site.callee}(... ${site.expression} ...)`);
      }
    }
    expect(
      unresolved,
      `Dynamic timeout expression(s) would bypass the registry policy. Use a named `
      + `numeric constant so the scanner can resolve and enforce the override:\n${unresolved.join('\n')}`,
    ).toEqual([]);
  });

  it('registers every discovered timeout override (fail closed on unregistered)', () => {
    const unregistered: string[] = [];
    for (const scan of scans) {
      for (const timeoutMs of scan.distinctTimeoutMs) {
        if (!registryByKey.has(`${scan.file}::${timeoutMs}`)) {
          unregistered.push(`${scan.file} @ ${timeoutMs}ms`);
        }
      }
    }
    expect(
      unregistered,
      `Unregistered integration timeout override(s). Add a measured or inherited `
      + `entry to integration-timeout-registry.json:\n${unregistered.join('\n')}`,
    ).toEqual([]);
  });

  it('has no stale registry entries (every entry maps to a live override)', () => {
    const discovered = new Set<string>();
    for (const scan of scans) {
      for (const timeoutMs of scan.distinctTimeoutMs) {
        discovered.add(`${scan.file}::${timeoutMs}`);
      }
    }
    const stale = registry.overrides
      .filter(entry => !discovered.has(`${entry.file}::${entry.timeoutMs}`))
      .map(entry => `${entry.file} @ ${entry.timeoutMs}ms`);
    expect(
      stale,
      `Stale registry entries no longer present in the source. Remove them:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('enforces the headroom ratio for measured baselines', () => {
    const ratio = registry.policy.minHeadroomRatio;
    expect(ratio).toBeGreaterThanOrEqual(2);
    const violations: string[] = [];
    for (const entry of registry.overrides) {
      if (entry.baselineSource !== 'measured') continue;
      if (typeof entry.measuredBaselineMs !== 'number' || entry.measuredBaselineMs <= 0) {
        violations.push(`${entry.file}: measured entry must carry a positive measuredBaselineMs`);
        continue;
      }
      const required = ratio * entry.measuredBaselineMs;
      if (entry.timeoutMs < required) {
        violations.push(
          `${entry.file}: timeout ${entry.timeoutMs}ms < ${ratio}x measured baseline `
          + `${entry.measuredBaselineMs}ms (needs >= ${required}ms)`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('requires every entry to be well-formed and inherited entries to declare debt', () => {
    const malformed: string[] = [];
    for (const entry of registry.overrides) {
      if (entry.baselineSource !== 'measured' && entry.baselineSource !== 'inherited') {
        malformed.push(`${entry.file}: baselineSource must be "measured" or "inherited"`);
      }
      if (!entry.note || entry.note.trim().length === 0) {
        malformed.push(`${entry.file}: every entry must carry a justification note`);
      }
      if (entry.baselineSource === 'inherited' && entry.measuredBaselineMs !== null) {
        malformed.push(`${entry.file}: inherited entry must set measuredBaselineMs to null`);
      }
      if (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0) {
        malformed.push(`${entry.file}: timeoutMs must be a positive integer`);
      }
    }
    expect(malformed, malformed.join('\n')).toEqual([]);
  });
});
