import { describe, expect, it } from 'vitest';

import {
  scanPublicSanitizeTrackedFiles,
  shouldScanTextContent,
} from '../../scripts/public-sanitize-check.mjs';

function buildOpenAiLikeToken() {
  const suffix = ['1234567890', '1234567890'].join('');
  return `sk-${suffix}`;
}

describe('public-sanitize check', () => {
  it('keeps source/docs in scope while excluding machine-managed beads history logs', () => {
    expect(shouldScanTextContent('src/index.ts')).toBe(true);
    expect(shouldScanTextContent('docs/README.md')).toBe(true);
    expect(shouldScanTextContent('.beads/README.md')).toBe(true);
    expect(shouldScanTextContent('.beads/daemon.log')).toBe(false);
    expect(shouldScanTextContent('.beads/issues.jsonl')).toBe(false);
    expect(shouldScanTextContent('.beads/beads.left.jsonl')).toBe(false);
    expect(shouldScanTextContent('.beads/interactions.jsonl')).toBe(false);
    expect(shouldScanTextContent('docs/image.png')).toBe(false);
  });

  it('detects blocked token patterns in in-scope files', () => {
    const tokenValue = buildOpenAiLikeToken();
    const result = scanPublicSanitizeTrackedFiles(
      ['src/example.ts'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [],
          textRuleRegex: [],
          loaded: false,
        },
        readTextFile: () => `export const token = '${tokenValue}';\n`,
      },
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].file).toBe('src/example.ts');
    expect(result.violations[0].rule).toBe('token-openai-like');
  });

  it('does not scan excluded beads history log content', () => {
    const tokenValue = buildOpenAiLikeToken();
    const reads: string[] = [];
    const result = scanPublicSanitizeTrackedFiles(
      ['.beads/daemon.log', '.beads/issues.jsonl', '.beads/beads.left.jsonl', '.beads/interactions.jsonl'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [],
          textRuleRegex: [],
          loaded: false,
        },
        readTextFile: (file) => {
          reads.push(file);
          return tokenValue;
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
