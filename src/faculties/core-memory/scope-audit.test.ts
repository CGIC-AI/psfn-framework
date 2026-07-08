import { describe, expect, it } from 'vitest';
import { auditCoreMemoryScopes } from './scope-audit.js';

describe('auditCoreMemoryScopes', () => {
  it('reports a clean scoped file with no issues', () => {
    const report = auditCoreMemoryScopes({
      version: 2,
      updatedAt: '2026-07-01T00:00:00.000Z',
      scopes: {
        'channel:room:townsquare': {
          scope: { kind: 'channel', key: 'channel:room:townsquare', channelId: 'room:townsquare' },
          updatedAt: '2026-07-01T00:00:00.000Z',
          blocks: {},
        },
      },
    });
    expect(report.issues).toHaveLength(0);
    expect(report.channelScopeKeys).toEqual(['channel:room:townsquare']);
  });

  it('flags a pre-scoped single-snapshot file', () => {
    const report = auditCoreMemoryScopes({ version: 1, updatedAt: 'x', blocks: {} });
    expect(report.issues.map(i => i.kind)).toContain('legacy_single_snapshot_file');
  });

  it('flags archived legacy_global and legacy_global-scoped rows', () => {
    const report = auditCoreMemoryScopes({
      version: 2,
      updatedAt: 'x',
      legacyGlobal: { archivedAt: 'y', snapshot: {} },
      scopes: {
        'legacy:global': { scope: { kind: 'legacy_global', key: 'legacy:global' }, updatedAt: 'x', blocks: {} },
      },
    });
    const kinds = report.issues.map(i => i.kind);
    expect(kinds).toContain('archived_legacy_global');
    expect(kinds).toContain('legacy_global_scope');
  });

  it('flags a non-canonical channel key and a descriptor key mismatch', () => {
    const report = auditCoreMemoryScopes({
      version: 2,
      updatedAt: 'x',
      scopes: {
        'room:townsquare': {
          scope: { kind: 'channel', key: 'room:townsquare', channelId: 'room:townsquare' },
          updatedAt: 'x',
          blocks: {},
        },
      },
    });
    const kinds = report.issues.map(i => i.kind);
    expect(kinds).toContain('noncanonical_channel_key');
  });
});
