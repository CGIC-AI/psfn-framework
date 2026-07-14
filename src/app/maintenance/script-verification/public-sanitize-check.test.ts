import { describe, expect, it } from 'vitest';

import {
  parseTrackedFilesFromGitLsStage,
  scanPublicSanitizeTrackedFiles,
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

  it('detects a deployment-specific host alias in tracked text', () => {
    const privateHostAlias = ['psfn', 'shard'].join('-');
    const result = scanPublicSanitizeTrackedFiles(
      ['docs/operations.md'],
      {
        localBlocklist: {
          localPath: 'workspace/sanitize/local-blocklist.json',
          forbiddenPathRegex: [],
          textRuleRegex: [],
          loaded: false,
        },
        readTextFile: () => `Live host: ${privateHostAlias}\n`,
      },
    );

    expect(result.violations.map((violation) => violation.rule)).toEqual(['live-host-alias']);
  });

  it('detects private network, hardware, and live-path fingerprints', () => {
    const privateValues = [
      ['100', '96', '206', '29'].join('.'),
      ['crawler', 'local', 'internal'].join('.'),
      ['', 'home', 'psfn', 'repository'].join('/'),
      ['', 'mnt', 'psfn-nvme', 'runtime'].join('/'),
      ['miniforum', '01'].join(''),
      `uuid: ${['d1f3c5fc', 'c352', '418f', '8fbd', 'bf72d84935a2'].join('-')}`,
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
      'live-service-home-path',
      'live-storage-mount-path',
      'private-node-name',
      'tailnet-address',
    ]);
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
