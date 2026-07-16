import type { Pool } from 'pg';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FleetAuthAuthorityFloorStore } from './authority-floor.js';
import { createGatewayAccountReapprovalAuthority } from './gateway-persistence.js';
import { executeAccountReapproval, type AccountReapprovalRequest } from './reapproval.js';

// A pool that fails loudly if the API ever reaches the database. Input
// validation must reject before any connection is acquired.
const NEVER_CONNECT_POOL = {
  connect: () => {
    throw new Error('reapproval validation must reject before connecting');
  },
} as unknown as Pool;

function baseRequest(): AccountReapprovalRequest {
  return {
    ceremonyId: '11111111-1111-4111-8111-111111111111',
    principalId: '22222222-2222-4222-8222-222222222222',
    provider: 'discord',
    providerSubjectId: '123456789012345678',
    companionId: '33333333-3333-4333-8333-333333333333',
    contactId: 'contact-owner',
    bindingId: '44444444-4444-4444-8444-444444444444',
    roleGrantId: '55555555-5555-4555-8555-555555555555',
    auditEventId: '66666666-6666-4666-8666-666666666666',
    at: '2026-07-15T12:00:00.000Z',
  };
}

describe('executeAccountReapproval input validation', () => {
  it.each([
    ['principal', baseRequest().principalId],
    ['companion', baseRequest().companionId],
  ] as const)('rejects a restored %s snapshot fenced by non-restored authority', async (
    kind,
    resourceId,
  ) => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-auth-reapproval-floor-'));
    chmodSync(root, 0o700);
    try {
      const floors = new FleetAuthAuthorityFloorStore(root);
      floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
      floors.revokeAccountAuthority({
        kind,
        resourceId,
        reason: 'lifecycle revocation',
        at: '2026-07-15T11:00:00.000Z',
      });
      await expect(createGatewayAccountReapprovalAuthority(
        NEVER_CONNECT_POOL,
        floors,
      )(baseRequest())).rejects.toThrow(/permanently tombstoned/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-UUID identifier before touching the database', async () => {
    await expect(executeAccountReapproval(NEVER_CONNECT_POOL, {
      ...baseRequest(),
      principalId: 'not-a-uuid',
    })).rejects.toThrow(/principalId must be an RFC-4122 UUID/);
  });

  it('rejects a non-discord provider', async () => {
    await expect(executeAccountReapproval(NEVER_CONNECT_POOL, {
      ...baseRequest(),
      provider: 'github' as unknown as 'discord',
    })).rejects.toThrow(/provider must be discord/);
  });

  it('rejects an invalid Discord provider subject id', async () => {
    await expect(executeAccountReapproval(NEVER_CONNECT_POOL, {
      ...baseRequest(),
      providerSubjectId: '123',
    })).rejects.toThrow(/providerSubjectId is invalid/);
  });

  it('rejects an empty contact id', async () => {
    await expect(executeAccountReapproval(NEVER_CONNECT_POOL, {
      ...baseRequest(),
      contactId: '',
    })).rejects.toThrow(/contactId is invalid/);
  });

  it('rejects a non-ISO timestamp', async () => {
    await expect(executeAccountReapproval(NEVER_CONNECT_POOL, {
      ...baseRequest(),
      at: 'yesterday',
    })).rejects.toThrow(/at must be an ISO timestamp/);
  });

  it('surfaces both the transaction failure and a failed rollback', async () => {
    const operationFailure = new Error('reapproval operation failed');
    const rollbackFailure = new Error('rollback failed');
    const client = {
      query: async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'ROLLBACK') throw rollbackFailure;
        throw operationFailure;
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    } as unknown as Pool;

    const rejection = await executeAccountReapproval(pool, baseRequest())
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect(rejection).toMatchObject({
      message: expect.stringMatching(/rollback failed after reapproval transaction error/i),
      errors: [operationFailure, rollbackFailure],
    });
  });
});
