import { isRecord } from '../../shared/utils/types.js';

/**
 * Read-only auditor for a persisted core-memory file. It REPORTS rows that are
 * legacy_global scoped or whose scope key does not match the canonical
 * `channel:<channelId>` derivation, so an operator can see which channels would
 * miss their scoped core-memory binding. It performs NO migration or mutation.
 */

export type CoreMemoryScopeIssueKind =
  | 'legacy_single_snapshot_file'
  | 'archived_legacy_global'
  | 'legacy_global_scope'
  | 'scope_key_mismatch'
  | 'noncanonical_channel_key'
  | 'unreadable_scope';

export interface CoreMemoryScopeIssue {
  kind: CoreMemoryScopeIssueKind;
  /** The map key (scope key) this issue is about, when applicable. */
  key?: string;
  detail: string;
}

export interface CoreMemoryScopeAuditReport {
  fileVersion: number | 'unknown';
  scopeCount: number;
  channelScopeKeys: string[];
  issues: CoreMemoryScopeIssue[];
}

function expectedChannelKey(channelId: string): string {
  return `channel:${channelId.trim().replace(/\s+/g, ' ')}`;
}

/**
 * Scan an already-parsed core-memory file object. Never throws on malformed
 * content; structural problems are surfaced as `unreadable_scope` issues.
 */
export function auditCoreMemoryScopes(parsed: unknown): CoreMemoryScopeAuditReport {
  const issues: CoreMemoryScopeIssue[] = [];
  const channelScopeKeys: string[] = [];

  if (!isRecord(parsed)) {
    return {
      fileVersion: 'unknown',
      scopeCount: 0,
      channelScopeKeys: [],
      issues: [{ kind: 'unreadable_scope', detail: 'core-memory file is not a JSON object' }],
    };
  }

  const version = typeof parsed.version === 'number' ? parsed.version : 'unknown';

  // Legacy single-snapshot format (pre-scoped): the entire file is unscoped
  // continuity that has never been re-homed into a channel scope.
  if (parsed.version === 1 && isRecord(parsed.blocks)) {
    issues.push({
      kind: 'legacy_single_snapshot_file',
      detail:
        'file is the pre-scoped single-snapshot format (version 1); its blocks are not bound to any channel scope',
    });
    return { fileVersion: version, scopeCount: 0, channelScopeKeys: [], issues };
  }

  if (isRecord(parsed.legacyGlobal)) {
    issues.push({
      kind: 'archived_legacy_global',
      detail:
        'file carries an archived legacyGlobal snapshot that was never re-homed into a channel scope',
    });
  }

  const scopes = isRecord(parsed.scopes) ? parsed.scopes : {};
  let scopeCount = 0;

  for (const [mapKey, rawRecord] of Object.entries(scopes)) {
    scopeCount += 1;
    if (!isRecord(rawRecord) || !isRecord(rawRecord.scope)) {
      issues.push({ kind: 'unreadable_scope', key: mapKey, detail: 'scope record is missing a scope descriptor' });
      continue;
    }
    const scope = rawRecord.scope;
    const scopeKind = scope.kind;

    if (scopeKind === 'legacy_global') {
      issues.push({
        kind: 'legacy_global_scope',
        key: mapKey,
        detail: 'scope descriptor kind is legacy_global; it is not bound to a channel',
      });
      continue;
    }

    if (typeof scope.key === 'string' && scope.key !== mapKey) {
      issues.push({
        kind: 'scope_key_mismatch',
        key: mapKey,
        detail: `map key "${mapKey}" does not match descriptor key "${scope.key}"`,
      });
    }

    const channelId = typeof scope.channelId === 'string' && scope.channelId.trim().length > 0
      ? scope.channelId
      : (typeof scope.key === 'string' ? scope.key.replace(/^channel:/, '') : undefined);

    if (!channelId) {
      issues.push({ kind: 'noncanonical_channel_key', key: mapKey, detail: 'channel scope has no resolvable channelId' });
      continue;
    }

    const expected = expectedChannelKey(channelId);
    if (mapKey !== expected) {
      issues.push({
        kind: 'noncanonical_channel_key',
        key: mapKey,
        detail: `key "${mapKey}" is not the canonical scope key for channel "${channelId}" (expected "${expected}")`,
      });
    } else {
      channelScopeKeys.push(mapKey);
    }
  }

  return { fileVersion: version, scopeCount, channelScopeKeys, issues };
}
