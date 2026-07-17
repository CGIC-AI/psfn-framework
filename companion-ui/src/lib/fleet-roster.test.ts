import { describe, expect, it, vi } from 'vitest';
import {
  FleetRosterClient,
  FleetRosterProtocolError,
  parseFleetApprovalsView,
  parseFleetRoster,
} from './fleet-roster.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const WS_A = `/companion-ui/companions/${COMPANION_A}/ws`;
const WS_B = `/companion-ui/companions/${COMPANION_B}/ws`;

function json(value: unknown, status = 200, cacheControl = 'no-store, private'): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Cache-Control': cacheControl, 'Content-Type': 'application/json' },
  });
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    companionId: COMPANION_B,
    companionDisplayName: 'Aria',
    id: 'confirm-1',
    title: 'web.fetch: https://example.test',
    requestedAt: '2026-07-17T10:00:00.000Z',
    expiresAt: '2026-07-18T10:00:00.000Z',
    redactedContext: 'Read documentation',
    status: 'pending',
    sourceSystem: 'tool-access',
    attribution: { parentId: COMPANION_B, parentLabel: 'Aria' },
    action: 'web.fetch',
    scope: 'https://example.test',
    reason: 'Read documentation',
    grantMode: { kind: 'once' },
    ...overrides,
  };
}

describe('fleet roster protocol', () => {
  it('accepts a valid roster with and without avatarRef', () => {
    const roster = parseFleetRoster({
      schemaVersion: 1,
      companions: [
        { companionId: COMPANION_A, displayName: 'Flagship', websocketPath: WS_A },
        { companionId: COMPANION_B, displayName: 'Aria', websocketPath: WS_B, avatarRef: 'a/b.png' },
      ],
    });
    expect(roster.companions).toHaveLength(2);
    expect(roster.companions[0]).not.toHaveProperty('avatarRef');
    expect(roster.companions[1]!.avatarRef).toBe('a/b.png');
  });

  it('accepts an empty roster (session may reach nothing)', () => {
    expect(parseFleetRoster({ schemaVersion: 1, companions: [] }).companions).toHaveLength(0);
  });

  it.each([
    // wrong schema version
    { schemaVersion: 2, companions: [] },
    // extra top-level key
    { schemaVersion: 1, companions: [], extra: true },
    // missing companions
    { schemaVersion: 1 },
    // non-array companions
    { schemaVersion: 1, companions: {} },
    // bad companionId (not lowercase uuid)
    { schemaVersion: 1, companions: [{ companionId: 'NOTAUUID', displayName: 'x', websocketPath: WS_A }] },
    // websocketPath does not belong to companionId (attribution mismatch)
    { schemaVersion: 1, companions: [{ companionId: COMPANION_A, displayName: 'x', websocketPath: WS_B }] },
    // websocketPath carries a query (authority injection)
    { schemaVersion: 1, companions: [{ companionId: COMPANION_A, displayName: 'x', websocketPath: `${WS_A}?token=1` }] },
    // hostile extra field on a companion entry
    { schemaVersion: 1, companions: [{ companionId: COMPANION_A, displayName: 'x', websocketPath: WS_A, role: 'owner' }] },
    // empty displayName
    { schemaVersion: 1, companions: [{ companionId: COMPANION_A, displayName: '', websocketPath: WS_A }] },
    // duplicate companion
    { schemaVersion: 1, companions: [
      { companionId: COMPANION_A, displayName: 'x', websocketPath: WS_A },
      { companionId: COMPANION_A, displayName: 'y', websocketPath: WS_A },
    ] },
  ])('rejects a malformed or hostile roster %#', (value) => {
    expect(() => parseFleetRoster(value)).toThrow(FleetRosterProtocolError);
  });

  it('accepts a valid approvals view and drops nothing it is given', () => {
    const view = parseFleetApprovalsView({
      schemaVersion: 1,
      approvals: [approval()],
    });
    expect(view.approvals[0]!.companionDisplayName).toBe('Aria');
  });

  it('accepts an approval without expiresAt', () => {
    const view = parseFleetApprovalsView({
      schemaVersion: 1,
      approvals: [approval({ title: 'web.fetch: x', expiresAt: undefined })],
    });
    expect(view.approvals[0]).not.toHaveProperty('expiresAt');
  });

  it.each([
    // non-pending status leaking a resolved entry
    { schemaVersion: 1, approvals: [{ companionId: COMPANION_B, companionDisplayName: 'Aria', id: 'c', title: 't', requestedAt: '2026-07-17T10:00:00.000Z', status: 'approved' }] },
    // hostile raw-param field
    { schemaVersion: 1, approvals: [{ companionId: COMPANION_B, companionDisplayName: 'Aria', id: 'c', title: 't', requestedAt: '2026-07-17T10:00:00.000Z', status: 'pending', params: { secret: 1 } }] },
    // bad timestamp
    { schemaVersion: 1, approvals: [{ companionId: COMPANION_B, companionDisplayName: 'Aria', id: 'c', title: 't', requestedAt: 'not-a-date', status: 'pending' }] },
    // bad companionId
    { schemaVersion: 1, approvals: [{ companionId: 'x', companionDisplayName: 'Aria', id: 'c', title: 't', requestedAt: '2026-07-17T10:00:00.000Z', status: 'pending' }] },
  ])('rejects a malformed or hostile approvals view %#', (value) => {
    expect(() => parseFleetApprovalsView(value)).toThrow(FleetRosterProtocolError);
  });
});

describe('fleet roster client', () => {
  it('reads the roster over a credentialed no-store request', async () => {
    const fetchImpl = vi.fn(async () => json({
      schemaVersion: 1,
      companions: [{ companionId: COMPANION_A, displayName: 'Flagship', websocketPath: WS_A }],
    }));
    const client = new FleetRosterClient(fetchImpl as typeof fetch);
    const roster = await client.readRoster();
    expect(roster.companions[0]!.companionId).toBe(COMPANION_A);
    expect(fetchImpl).toHaveBeenCalledWith('/v1/fleet-auth/companions', expect.objectContaining({
      credentials: 'include', cache: 'no-store', redirect: 'error',
    }));
  });

  it('reads the fleet-wide approvals view', async () => {
    const fetchImpl = vi.fn(async () => json({ schemaVersion: 1, approvals: [] }));
    const client = new FleetRosterClient(fetchImpl as typeof fetch);
    await expect(client.readApprovals()).resolves.toEqual({ schemaVersion: 1, approvals: [] });
    expect(fetchImpl).toHaveBeenCalledWith('/v1/fleet-auth/approvals', expect.objectContaining({
      credentials: 'include', cache: 'no-store',
    }));
  });

  it('fails closed when the response is not no-store', async () => {
    const fetchImpl = vi.fn(async () => json({ schemaVersion: 1, companions: [] }, 200, 'public'));
    const client = new FleetRosterClient(fetchImpl as typeof fetch);
    await expect(client.readRoster()).rejects.toThrow(FleetRosterProtocolError);
  });

  it('fails closed on a non-200 status', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'nope' }, 401));
    const client = new FleetRosterClient(fetchImpl as typeof fetch);
    await expect(client.readRoster()).rejects.toThrow(FleetRosterProtocolError);
  });
});
