import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONCERN_SOFTENING_CONFIG_FILE_NAME,
  getConcernSofteningConfig,
  parseConcernSofteningConfig,
  resetConcernSofteningConfigCacheForTests,
} from './concern-softening.js';
import { buildActiveConcernsRuntimeData } from './concerns.js';

let tempDir: string | null = null;
const originalConfigDir = process.env.CONFIG_DIR;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (originalConfigDir === undefined) {
    delete process.env.CONFIG_DIR;
  } else {
    process.env.CONFIG_DIR = originalConfigDir;
  }
  resetConcernSofteningConfigCacheForTests();
});

function useConfigDir(config: unknown): void {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-concern-softening-'));
  writeFileSync(join(tempDir, CONCERN_SOFTENING_CONFIG_FILE_NAME), JSON.stringify(config));
  process.env.CONFIG_DIR = tempDir;
  resetConcernSofteningConfigCacheForTests();
}

function makeConcern(text: string) {
  return {
    id: 'concern-1',
    text,
    priority: 'high' as const,
    source: 'agent' as const,
    status: 'active' as const,
    createdAt: '2026-02-01T10:00:00.000Z',
    expiresAt: '2026-02-01T11:00:00.000Z',
    salience: 0.5,
    sensitivity: 'personal' as const,
    owner: 'companion' as const,
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
  };
}

describe('concern softening rules (E2.5: operator-tunable data)', () => {
  it('ships a default config that reproduces the previous hardcoded behavior', () => {
    // Default file at repo config/: strip possessive prefixes, soften
    // "concern" wording, truncate at 140 chars — byte-identical to the old
    // code-owned rules.
    resetConcernSofteningConfigCacheForTests();
    const config = getConcernSofteningConfig();
    expect(config.maxTextChars).toBe(140);
    expect(config.rewriteRules).toHaveLength(4);

    const data = buildActiveConcernsRuntimeData([
      makeConcern("User's active concern about the concern backlog"),
    ]);
    expect(data.topLines[0]).toContain('open thread about the thread backlog');
    expect(data.topLines[0]).not.toMatch(/concern/i);
  });

  it('applies operator-tuned rules from CONFIG_DIR', () => {
    useConfigDir({
      schemaVersion: 1,
      maxTextChars: 32,
      rewriteRules: [
        { pattern: '\\bworry\\b', flags: 'gi', replacement: 'gentle thread' },
      ],
    });

    const data = buildActiveConcernsRuntimeData([
      makeConcern('worry about the very long database migration rollback plan'),
    ]);
    expect(data.topLines[0]).toContain('gentle thread about');
    // Truncation honors the tuned maxTextChars.
    const bracketIndex = data.topLines[0]!.indexOf(' [high;');
    const softened = data.topLines[0]!.slice(2, bracketIndex);
    expect(softened.length).toBeLessThanOrEqual(32);
    expect(softened.endsWith('...')).toBe(true);
  });

  it('fails closed on malformed config', () => {
    expect(() => parseConcernSofteningConfig({ schemaVersion: 2 }, 'test.json'))
      .toThrow(/schemaVersion must be 1/);
    expect(() => parseConcernSofteningConfig({
      schemaVersion: 1,
      maxTextChars: 4,
      rewriteRules: [],
    }, 'test.json')).toThrow(/maxTextChars/);
    expect(() => parseConcernSofteningConfig({
      schemaVersion: 1,
      maxTextChars: 140,
      rewriteRules: [{ pattern: '(', flags: 'g', replacement: '' }],
    }, 'test.json')).toThrow(/not a valid regular expression/);
    expect(() => parseConcernSofteningConfig({
      schemaVersion: 1,
      maxTextChars: 140,
      rewriteRules: [{ pattern: 'x', flags: 'zz', replacement: '' }],
    }, 'test.json')).toThrow(/flags/);
  });
});
