import { describe, expect, it } from 'vitest';

import {
  parseTrackedFilesFromGitLsStage,
  scanPublicSanitizeTrackedFiles,
  shouldScanSourceForNulByte,
  shouldScanTextContent,
} from '../../../../scripts/public-sanitize-check.mjs';

function buildOpenAiLikeToken() {
  const suffix = ['1234567890', '1234567890'].join('');
  return `sk-${suffix}`;
}

describe('public-sanitize check', () => {
  it('keeps source/docs in scope while excluding machine-managed beads history logs', () => {
    expect(shouldScanTextContent('src/app/agent/main.ts')).toBe(true);
    expect(shouldScanTextContent('docs/README.md')).toBe(true);
    expect(shouldScanTextContent('.beads/README.md')).toBe(true);
    expect(shouldScanTextContent('.beads/daemon.log')).toBe(false);
    expect(shouldScanTextContent('.beads/issues.jsonl')).toBe(false);
    expect(shouldScanTextContent('.beads/beads.left.jsonl')).toBe(false);
    expect(shouldScanTextContent('.beads/interactions.jsonl')).toBe(false);
    expect(shouldScanTextContent('docs/image.png')).toBe(false);
  });

  it('checks tracked source code for literal NUL bytes', () => {
    expect(shouldScanSourceForNulByte('src/app/agent/main.ts')).toBe(true);
    expect(shouldScanSourceForNulByte('scripts/check.mjs')).toBe(true);
    expect(shouldScanSourceForNulByte('docs/README.md')).toBe(false);
    expect(shouldScanSourceForNulByte('src/fixture.docx')).toBe(false);

    const nul = String.fromCharCode(0);
    const result = scanPublicSanitizeTrackedFiles(
      ['src/example.ts'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [],
          textRuleRegex: [],
          loaded: false,
        },
        readTextFile: () => `const safe = '\\x00';\nconst unsafe = 'before${nul}after';\n`,
      },
    );

    expect(result.violations).toEqual([
      {
        file: 'src/example.ts',
        line: 2,
        rule: 'literal-nul-byte',
        snippet: 'U+0000 (NUL)',
      },
    ]);
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

  it('detects generic private-network, hostname, and hardware fingerprints', () => {
    const privateValues = [
      ['100', '64', '0', '1'].join('.'),
      ['example-node', 'local', 'internal'].join('.'),
      `uuid: ${['11111111', '2222', '4333', '8444', '555555555555'].join('-')}`,
    ];
    const result = scanPublicSanitizeTrackedFiles(
      ['docs/operations.md'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [],
          textRuleRegex: [],
          loaded: false,
        },
        readTextFile: () => privateValues.join('\n'),
      },
    );

    expect(result.violations.map((violation) => violation.rule).sort()).toEqual([
      'internal-local-hostname',
      'live-hardware-uuid',
      'tailnet-address',
    ]);
  });

  it('applies ignored local patterns for deployment-specific values', () => {
    const result = scanPublicSanitizeTrackedFiles(
      ['docs/private-example-operations.md', 'docs/attribution.md'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [
            { name: 'local-path-1', regex: /private-example/iu },
          ],
          textRuleRegex: [
            { name: 'local-text-1', regex: /private-operator|\/home\/private-user/giu },
          ],
          loaded: true,
        },
        readTextFile: (file) => file.endsWith('attribution.md')
          ? 'Maintainer: private-operator; source: /home/private-user/project'
          : 'generic content',
      },
    );

    expect(result.violations.map((violation) => violation.rule).sort()).toEqual([
      'local-path-1',
      'local-text-1',
      'local-text-1',
    ]);
  });

  it('rejects tracked session archives and Beads runtime logs', () => {
    const result = scanPublicSanitizeTrackedFiles(
      ['working_docs/session-export.zip', '.beads/daemon.log'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [],
          textRuleRegex: [],
          loaded: false,
        },
        readTextFile: () => '',
      },
    );

    expect(result.violations.map((violation) => violation.rule).sort()).toEqual([
      'tracked-beads-runtime-log',
      'tracked-session-archive',
    ]);
  });

  it('does not scan excluded beads history log content', () => {
    const tokenValue = buildOpenAiLikeToken();
    const reads: string[] = [];
    const result = scanPublicSanitizeTrackedFiles(
      ['.beads/issues.jsonl', '.beads/beads.left.jsonl', '.beads/interactions.jsonl'],
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

  it('drops gitlink submodule entries from tracked-file scanning', () => {
    const trackedFiles = parseTrackedFilesFromGitLsStage([
      '100644 1111111111111111111111111111111111111111 0\tsrc/app/main.ts',
      '160000 2222222222222222222222222222222222222222 0\tvendor/emosim',
      '100644 3333333333333333333333333333333333333333 0\tdocs/setup.md',
      '',
    ].join('\0'));

    expect(trackedFiles).toEqual([
      'src/app/main.ts',
      'docs/setup.md',
    ]);
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
