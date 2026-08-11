import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunChargeEvent } from '../../../shared/contracts/runtime.js';
import type { RunChargeLedgerData } from '../../../shared/telemetry/charge-ledger.js';
import {
  AdminAuditHistoryDataService,
  GardenAuditHistoryJsonlStore,
  type GatewayAuditHistoryReader,
} from './audit-history-service.js';
import type { FleetGardenRequestContext } from '../garden-request-context.js';

const TEST_OPAQUE_ID_KEYRING = {
  activeVersion: 'v1',
  keys: { v1: 'audit-history-test-secret-that-is-not-public' },
};

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-garden-audit-history-'));
  tempDirs.push(dir);
  return dir;
}

function fleetRequestContext(): FleetGardenRequestContext {
  const authorization = Object.freeze({
    action: 'settings.write' as const,
    baseRole: 'admin' as const,
    resource: Object.freeze({ scope: 'personal_workspace' as const, area: 'personal_settings' as const }),
    subjectRelation: 'current_companion' as const,
    requirements: Object.freeze({ assurance: 'oauth' as const, confirmation: 'explicit' as const,
      approvals: Object.freeze([]) }),
    publicAccess: 'never' as const,
    recoveryAccess: 'forbidden' as const,
  });
  return Object.freeze({
    kind: 'fleet_principal', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', authorizationEventId: 'event-a',
    resolvedAt: '2030-01-01T00:00:00.000Z', issuedAt: 1, expiresAt: 2,
    versions: Object.freeze({ authorityGeneration: 2, globalAuthEpoch: 3, sessionAuthnVersion: 5,
      sessionAuthzVersion: 7, bindingVersion: 11, grantVersion: 13, policyVersion: 17 }),
    actor: Object.freeze({ kind: 'fleet_principal', principalId: 'principal-a', provider: 'discord',
      providerSubjectId: '12345678901234567', contactId: 'contact-a', contactBindingId: 'binding-a',
      role: 'admin', operatorGrantId: 'grant-a', sessionRecordId: 'session-a',
      sessionAssurance: 'oauth', accessMode: 'multi_admin' }),
    action: 'settings.write',
    resource: Object.freeze({ routeId: 'PATCH /api/admin/settings', scope: 'personal_workspace',
      area: 'personal_settings', companionId: '11111111-1111-4111-8111-111111111111',
      pathParams: Object.freeze({}), query: Object.freeze({}) }),
    subjectRelation: 'current_companion', authorization,
  });
}

function makeChargeEvent(overrides: Partial<RunChargeEvent> = {}): RunChargeEvent {
  return {
    eventId: randomUUID(),
    timestampMs: 1_700_000_000_300,
    lane: 'interactive',
    surface: 'externalModelConsult',
    amount: 2,
    quota: 10,
    spentAfter: 2,
    remainingAfter: 8,
    lineage: {
      runId: 'run-a',
      rootRunId: 'run-a',
    },
    details: {
      provider: 'openrouter',
      model: 'test/model',
    },
    ...overrides,
  };
}

function gardenAuditLine(index: number, raw: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    recordType: 'garden_audit_history',
    entry: {
      id: `legacy-${index}`,
      timestamp: index,
      source: 'garden',
      sourceRecordId: `garden:${index}`,
      actionType: 'settings_change',
      decision: 'allowed',
      narrative: `Audit entry ${index}`,
      raw,
    },
  });
}

describe('GardenAuditHistoryJsonlStore', () => {
  it('reads only a bounded recent tail and memoizes unchanged file identities', () => {
    const path = join(makeTempDir(), 'garden-audit-history.jsonl');
    const contents = Array.from(
      { length: 100 },
      (_, index) => gardenAuditLine(index, { padding: 'x'.repeat(512) }),
    ).join('\n') + '\n';
    writeFileSync(path, contents);
    const observedReads: number[] = [];
    const store = new GardenAuditHistoryJsonlStore(path, {
      maxEntries: 10,
      maxReadBytes: 8 * 1_024,
      onRead: bytes => observedReads.push(bytes),
    });

    const first = store.list();
    const readsAfterFirst = [...observedReads];
    const second = store.list();

    expect(first).toHaveLength(10);
    expect(first.map(entry => entry.timestamp)).toEqual(
      Array.from({ length: 10 }, (_, index) => 90 + index),
    );
    expect(second).toEqual(first);
    expect(observedReads).toEqual(readsAfterFirst);
    expect(observedReads.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(Buffer.byteLength(contents));
  });

  it('invalidates the memo after append and file replacement', () => {
    const dir = makeTempDir();
    const path = join(dir, 'garden-audit-history.jsonl');
    writeFileSync(path, `${gardenAuditLine(1)}\n`);
    const store = new GardenAuditHistoryJsonlStore(path);

    expect(store.list().map(entry => entry.timestamp)).toEqual([1]);
    store.append({
      id: 'new-entry',
      timestamp: 2,
      source: 'garden',
      actionType: 'settings_change',
      decision: 'allowed',
      narrative: 'New entry',
    });
    expect(store.list().map(entry => entry.timestamp)).toEqual([1, 2]);

    const replacement = join(dir, 'replacement.jsonl');
    writeFileSync(replacement, `${gardenAuditLine(3)}\n`);
    renameSync(replacement, path);
    expect(store.list().map(entry => entry.timestamp)).toEqual([3]);
  });

  it('fails closed when the audit file mutates during a read', () => {
    const path = join(makeTempDir(), 'garden-audit-history.jsonl');
    writeFileSync(path, `${gardenAuditLine(1)}\n`);
    const initialSize = statSync(path).size;
    const store = new GardenAuditHistoryJsonlStore(path, {
      afterRead: vi.fn(() => appendFileSync(path, `${gardenAuditLine(2)}\n`)),
    });

    expect(() => store.list()).toThrow(/changed while it was being read/i);
    expect(statSync(path).size).toBeGreaterThan(initialSize);
  });
});

describe('AdminAuditHistoryDataService', () => {
  it('persists immutable request actor, decision, resource, and version attribution', async () => {
    const service = new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(join(makeTempDir(), 'garden-audit-history.jsonl')),
      gatewayReader: null,
      chargeLedger: null,
      scopeId: 'companion-a',
      opaqueIdKeyring: TEST_OPAQUE_ID_KEYRING,
      now: () => 1_700_000_000_500,
    });
    service.appendGardenEntry({
      actionType: 'settings_change',
      decision: 'allowed',
      narrative: 'Trusted request changed settings.',
      actor: 'operator',
      requestContext: fleetRequestContext(),
    });

    const data = await service.getAuditHistory({ source: 'garden', timeRange: 'all' });
    expect(data.entries[0]?.requestAttribution).toMatchObject({
      actor: { kind: 'fleet_principal', principalId: 'principal-a', contactId: 'contact-a', role: 'admin' },
      companionId: '11111111-1111-4111-8111-111111111111',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      action: 'settings.write',
      routeId: 'PATCH /api/admin/settings',
      subjectRelation: 'current_companion',
      authorityVersions: { authorityGeneration: 2, sessionAuthzVersion: 7, policyVersion: 17 },
    });
  });

  it('merges persisted Garden audit, gateway audit, and charge ledger history with paging', async () => {
    const dir = makeTempDir();
    const gardenStore = new GardenAuditHistoryJsonlStore(join(dir, 'garden-audit-history.jsonl'));
    const gatewayReader: GatewayAuditHistoryReader = vi.fn(() => ({
      entries: [
        {
          id: 7,
          timestamp: 1_700_000_000_200,
          method: 'fs.write',
          decision: 'DENY',
          paramsJson: '{"path":"/blocked"}',
          durationMs: 4,
          error: 'policy denied',
        },
      ],
      total: 1,
      limit: 2_000,
      offset: 0,
    }));
    const chargeLedger = {
      getData: vi.fn(async (): Promise<RunChargeLedgerData> => ({
        activeRun: null,
        recentRuns: [],
        aggregates: {
          amount: 2,
          eventCount: 1,
          byLane: [],
          bySurface: [],
          byLineage: [],
        },
        events: [
          {
            schemaVersion: 1,
            recordType: 'charge_event',
            eventId: 'charge-1',
            recordedAtMs: 1_700_000_000_301,
            event: makeChargeEvent(),
            metadata: {
              provider: 'openrouter',
              model: 'test/model',
            },
          },
        ],
      })),
    };
    const service = new AdminAuditHistoryDataService({
      gardenStore,
      gatewayReader,
      chargeLedger,
      scopeId: 'companion-a',
      opaqueIdKeyring: TEST_OPAQUE_ID_KEYRING,
      now: () => 1_700_000_000_500,
    });

    service.appendGardenEntry({
      actionType: 'settings_change',
      decision: 'allowed',
      narrative: 'Operator updated runtime settings.',
      actor: 'operator',
      timestamp: 1_700_000_000_100,
    });

    const data = await service.getAuditHistory({
      timeRange: 'all',
      limit: 2,
      offset: 0,
    });

    expect(data.pagination).toMatchObject({
      limit: 2,
      offset: 0,
      total: 3,
      hasNext: true,
    });
    expect(data.entries.map(entry => entry.source)).toEqual(['charge', 'gateway']);
    expect(data.entries[0]).toMatchObject({
      actionType: 'charge_decision',
      decision: 'allowed',
    });
    expect(data.entries[1]).toMatchObject({
      actionType: 'gateway_policy',
      decision: 'denied',
    });
  });

  it.each(['AUTONOMOUS_TIER_REQUIRED', 'REQUIRES_HUMAN_APPROVAL'] as const)(
    'maps gateway escalation class %s to a pending-approval audit decision',
    async (decision) => {
      const service = new AdminAuditHistoryDataService({
        gardenStore: new GardenAuditHistoryJsonlStore(join(makeTempDir(), 'garden-audit-history.jsonl')),
        gatewayReader: () => ({
          entries: [{
            id: 8,
            timestamp: 1_700_000_000_200,
            method: 'fs.write',
            decision,
            paramsJson: '{"path":"/outside"}',
            durationMs: null,
            error: null,
          }],
          total: 1,
          limit: 2_000,
          offset: 0,
        }),
        chargeLedger: null,
        scopeId: 'companion-a',
        opaqueIdKeyring: TEST_OPAQUE_ID_KEYRING,
        now: () => 1_700_000_000_500,
      });

      const data = await service.getAuditHistory({
        source: 'gateway',
        decision: 'needs_approval',
        timeRange: 'all',
      });

      expect(data.entries).toHaveLength(1);
      expect(data.entries[0]).toMatchObject({
        actionType: 'gateway_policy',
        decision: 'needs_approval',
      });
    },
  );

  it('filters historical audit rows by source, action type, decision, and text', async () => {
    const dir = makeTempDir();
    const service = new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(join(dir, 'garden-audit-history.jsonl')),
      gatewayReader: null,
      chargeLedger: null,
      scopeId: 'companion-a',
      opaqueIdKeyring: TEST_OPAQUE_ID_KEYRING,
      now: () => 1_700_000_000_500,
    });

    service.appendGardenEntry({
      actionType: 'confirmation',
      decision: 'denied',
      narrative: 'Operator resolved confirmation abc: denied.',
      actor: 'operator',
      timestamp: 1_700_000_000_200,
    });
    service.appendGardenEntry({
      actionType: 'tool_activation',
      decision: 'allowed',
      narrative: 'Adaptive tool "repo_diff" was activated.',
      actor: 'companion',
      timestamp: 1_700_000_000_100,
    });

    const data = await service.getAuditHistory({
      source: 'garden',
      actionType: 'confirmation',
      decision: 'denied',
      query: 'abc',
      timeRange: 'all',
    });

    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({
      actionType: 'confirmation',
      decision: 'denied',
      actor: 'operator',
    });
  });

  it('keeps raw source records out of list payloads and resolves them only by scoped opaque id', async () => {
    const dir = makeTempDir();
    const gatewayReader: GatewayAuditHistoryReader = () => ({
      entries: [{
        id: 7,
        timestamp: 1_700_000_000_200,
        method: 'external.call',
        decision: 'ALLOW',
        paramsJson: '{"authorization":"partner-secret"}',
        durationMs: 4,
        error: 'upstream rejected partner-secret',
      }],
      total: 1,
      limit: 2_000,
      offset: 0,
    });
    const makeService = (
      scopeId: string,
      opaqueIdKeyring = TEST_OPAQUE_ID_KEYRING,
    ) => new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(join(dir, `${scopeId}.jsonl`)),
      gatewayReader,
      chargeLedger: null,
      scopeId,
      opaqueIdKeyring,
      now: () => 1_700_000_000_500,
    });
    const service = makeService('companion-a');

    const list = await service.getAuditHistory({ timeRange: 'all' });
    const repeatedList = await makeService('companion-a').getAuditHistory({ timeRange: 'all' });
    const otherCompanion = makeService('companion-b');
    const otherList = await otherCompanion.getAuditHistory({ timeRange: 'all' });

    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.id).toMatch(/^audit_[A-Za-z0-9_-]{43}$/);
    expect(list.entries[0]?.id).toBe(repeatedList.entries[0]?.id);
    expect(list.entries[0]?.id).not.toBe(otherList.entries[0]?.id);
    expect(JSON.stringify(list)).not.toContain('partner-secret');
    expect(list.entries[0]?.details).toBe('durationMs=4 error=present');
    expect(list.entries[0]).not.toHaveProperty('raw');
    expect(list.entries[0]).not.toHaveProperty('sourceRecordId');

    const detail = await service.getAuditHistoryDetail(list.entries[0]!.id);
    expect(detail.entry).toEqual(list.entries[0]);
    expect(detail.raw).toMatchObject({
      paramsJson: expect.stringContaining('partner-secret'),
      error: expect.stringContaining('partner-secret'),
    });
    await expect(otherCompanion.getAuditHistoryDetail(list.entries[0]!.id)).rejects.toThrow(/not found/i);

    const otherKey = makeService('companion-a', {
      activeVersion: 'v2',
      keys: { v2: 'different-server-only-secret' },
    });
    const otherKeyList = await otherKey.getAuditHistory({ timeRange: 'all' });
    expect(otherKeyList.entries[0]?.id).not.toBe(list.entries[0]?.id);
    await expect(otherKey.getAuditHistoryDetail(list.entries[0]!.id)).rejects.toThrow(/not found/i);
  });

  it('fails closed without a usable server-side opaque-id key', () => {
    const dir = makeTempDir();
    expect(() => new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(join(dir, 'audit.jsonl')),
      gatewayReader: null,
      chargeLedger: null,
      scopeId: 'companion-a',
      opaqueIdKeyring: { activeVersion: 'missing', keys: {} },
    })).toThrow(/opaque.*key/i);
  });

  it('does not permit offline derivation from predictable sequential source ids', async () => {
    const dir = makeTempDir();
    const service = new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(join(dir, 'audit.jsonl')),
      gatewayReader: () => ({
        entries: [7, 8].map(id => ({
          id,
          timestamp: id,
          method: 'fs.read',
          decision: 'ALLOW' as const,
          paramsJson: '{}',
          durationMs: 1,
          error: null,
        })),
        total: 2,
        limit: 2_000,
        offset: 0,
      }),
      chargeLedger: null,
      scopeId: 'companion-a',
      opaqueIdKeyring: TEST_OPAQUE_ID_KEYRING,
    });

    const list = await service.getAuditHistory({ timeRange: 'all' });
    const unkeyedOfflineGuess = `audit_${createHash('sha256')
      .update('companion-a')
      .update('\0')
      .update('gateway')
      .update('\0')
      .update('7')
      .digest('base64url')}`;

    expect(new Set(list.entries.map(entry => entry.id)).size).toBe(2);
    expect(list.entries.map(entry => entry.id)).not.toContain(unkeyedOfflineGuess);
  });

  it('does not expose arbitrary gateway reader failures in list-visible source status', async () => {
    const dir = makeTempDir();
    const service = new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(join(dir, 'audit.jsonl')),
      gatewayReader: () => {
        throw new Error('postgres password=partner-secret');
      },
      chargeLedger: null,
      scopeId: 'companion-a',
      opaqueIdKeyring: TEST_OPAQUE_ID_KEYRING,
    });

    const list = await service.getAuditHistory({ timeRange: 'all' });

    expect(list.sources.gateway).toEqual({
      available: false,
      count: 0,
      message: 'Gateway audit history could not be read.',
    });
    expect(JSON.stringify(list)).not.toContain('partner-secret');
  });

  it('filters only inside the same bounded unfiltered source window used by detail lookup', async () => {
    const dir = makeTempDir();
    const calls: Array<Record<string, unknown>> = [];
    const recentAllowed = Array.from({ length: 2_000 }, (_, index) => ({
      id: index + 1,
      timestamp: 10_000 - index,
      method: 'fs.read',
      decision: 'ALLOW' as const,
      paramsJson: '{}',
      durationMs: 1,
      error: null,
    }));
    const olderDenied = {
      id: 2_001,
      timestamp: 7_999,
      method: 'fs.read',
      decision: 'DENY' as const,
      paramsJson: '{}',
      durationMs: 1,
      error: 'denied',
    };
    const gatewayReader: GatewayAuditHistoryReader = query => {
      calls.push(query as Record<string, unknown>);
      const entries = query.decision === 'DENY'
        ? [olderDenied]
        : recentAllowed.slice(0, query.limit);
      return { entries, total: entries.length, limit: query.limit, offset: 0 };
    };
    const service = new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(join(dir, 'audit.jsonl')),
      gatewayReader,
      chargeLedger: null,
      scopeId: 'companion-a',
      opaqueIdKeyring: TEST_OPAQUE_ID_KEYRING,
      now: () => 20_000,
    });

    const list = await service.getAuditHistory({ decision: 'denied', timeRange: 'all' });

    expect(list.entries).toEqual([]);
    expect(calls).toEqual([{ limit: 2_000 }]);
  });
});
