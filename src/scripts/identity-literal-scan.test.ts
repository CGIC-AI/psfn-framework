import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadAllowlist,
  readScanEntriesFromFiles,
  scanIdentityLiteralEntries,
  shouldScanFile,
} from '../../scripts/identity-literal-scan.mjs';

describe('identity-literal scan', () => {
  it('reports violations with pattern, line, and column details', () => {
    const result = scanIdentityLiteralEntries([
      {
        path: 'src/example.ts',
        text: "export const greeting = 'Hello PSFN';\n",
      },
    ]);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('src/example.ts');
    expect(result.violations[0].line).toBe(1);
    expect(result.violations[0].column).toBeGreaterThan(1);
    expect(result.violations[0].pattern).toBe('identity-proper-name');
  });

  it('suppresses violations through explicit allowlist entries', () => {
    const result = scanIdentityLiteralEntries(
      [
        {
          path: 'src/identity/loader.ts',
          text: "const LEGACY_BOOTSTRAP_NAME = 'PSFN';\n",
        },
      ],
      {
        allowlist: [
          {
            path: 'src/identity/loader.ts',
            contains: "LEGACY_BOOTSTRAP_NAME = 'PSFN'",
            reason: 'legacy migration constant',
          },
        ],
      },
    );

    expect(result.violations).toHaveLength(0);
    expect(result.allowlisted).toHaveLength(1);
    expect(result.allowlisted[0].reason).toBe('legacy migration constant');
  });

  it('keeps violation when allowlist entry does not match line text', () => {
    const result = scanIdentityLiteralEntries(
      [
        {
          path: 'src/identity/loader.ts',
          text: "const LEGACY_BOOTSTRAP_NAME = 'PSFN';\n",
        },
      ],
      {
        allowlist: [
          {
            path: 'src/identity/loader.ts',
            contains: 'different text',
            reason: 'mismatch',
          },
        ],
      },
    );

    expect(result.violations).toHaveLength(1);
    expect(result.allowlisted).toHaveLength(0);
  });

  it('scopes allowlist suppression by pattern to avoid masking other hits on the same line', () => {
    const result = scanIdentityLiteralEntries(
      [
        {
          path: 'src/identity/loader.ts',
          text: "const LEGACY = 'PSFN psfn';\n",
        },
      ],
      {
        allowlist: [
          {
            path: 'src/identity/loader.ts',
            contains: "LEGACY = 'PSFN psfn'",
            reason: 'allow proper-name only',
            pattern: 'identity-proper-name',
          },
        ],
      },
    );

    expect(result.allowlisted).toHaveLength(1);
    expect(result.allowlisted[0].pattern).toBe('identity-proper-name');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].pattern).toBe('identity-legacy-slug');
  });

  it('loads valid allowlist entries and drops malformed ones', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'identity-literal-allowlist-'));
    const file = path.join(dir, 'allowlist.json');
    try {
      writeFileSync(file, JSON.stringify({
        entries: [
          {
            path: 'src/a.ts',
            contains: 'PSFN',
            reason: 'allowed',
          },
          {
            path: '',
            contains: 'PSFN',
            reason: 'invalid',
          },
          {
            path: 'src/b.ts',
          },
        ],
      }), 'utf8');

      const loaded = loadAllowlist(file);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].path).toBe('src/a.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans source-like files and skips test/fixture paths', () => {
    expect(shouldScanFile('src/app.ts')).toBe(true);
    expect(shouldScanFile('admin-ui/src/routes/+page.svelte')).toBe(true);
    expect(shouldScanFile('scripts/identity-literal-scan.mjs')).toBe(false);
    expect(shouldScanFile('src/app.test.ts')).toBe(false);
    expect(shouldScanFile('src/__tests__/sample.ts')).toBe(false);
    expect(shouldScanFile('docs/README.md')).toBe(false);
  });

  it('fails closed when a scoped file cannot be read', () => {
    expect(() => readScanEntriesFromFiles(['src/does-not-exist.ts'])).toThrow();
  });
});
