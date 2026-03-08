import { describe, expect, it } from 'vitest';

import {
  scanPublicSanitizeTrackedFiles,
  shouldScanTextContent,
} from '../../scripts/public-sanitize-check.mjs';

describe('public-sanitize check', () => {
  it('keeps source/docs in scope while excluding historical bead issue log content', () => {
    expect(shouldScanTextContent('src/index.ts')).toBe(true);
    expect(shouldScanTextContent('docs/README.md')).toBe(true);
    expect(shouldScanTextContent('.beads/issues.jsonl')).toBe(false);
    expect(shouldScanTextContent('docs/image.png')).toBe(false);
  });

  it('detects blocked token patterns in in-scope files', () => {
    const result = scanPublicSanitizeTrackedFiles(
      ['src/example.ts'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [],
          textRuleRegex: [],
          loaded: false,
        },
        readTextFile: () => "export const token = 'sk-12345678901234567890';\n",
      },
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('src/example.ts');
    expect(result.violations[0].rule).toBe('token-openai-like');
  });

  it('does not scan excluded .beads/issues.jsonl content', () => {
    const reads: string[] = [];
    const result = scanPublicSanitizeTrackedFiles(
      ['.beads/issues.jsonl'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [],
          textRuleRegex: [],
          loaded: false,
        },
        readTextFile: (file) => {
          reads.push(file);
          return 'sk-12345678901234567890';
        },
      },
    );

    expect(result.violations).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  it('fails closed when an in-scope file cannot be read', () => {
    expect(() => scanPublicSanitizeTrackedFiles(
      ['docs/security.md'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [],
          textRuleRegex: [],
          loaded: false,
        },
        readTextFile: () => {
          throw new Error('EACCES');
        },
      },
    )).toThrow('EACCES');
  });
});
