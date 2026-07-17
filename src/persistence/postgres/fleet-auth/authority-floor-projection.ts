import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  AccountAuthorityTombstoneKind,
  TrustedHostAuthorityFloor,
} from './authority-floor.js';
import { companionAuthorityLineageId } from './authority-floor.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function replaceAccountAuthorityFloorProjection(
  client: PoolClient,
  trustedHost: TrustedHostAuthorityFloor,
): Promise<void> {
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
  `);
  for (const tombstone of trustedHost.tombstones) {
    // Recovery-credential fences are trusted-host-only authority. They are
    // deliberately never projected into restorable account authority.
    if (tombstone.kind === 'recovery_credential') continue;
    const lineageId = tombstone.kind === 'companion_lineage_floor'
      ? companionAuthorityLineageId(trustedHost, tombstone.resourceHash, tombstone.generation)
      : null;
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
        (kind, resource_hash, authority_generation, companion_lineage_id,
         companion_readd_decision_id)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      tombstone.kind,
      tombstone.resourceHash,
      tombstone.generation,
      lineageId,
      tombstone.companionReadd?.decisionId ?? null,
    ]);
  }
}

export async function appendAccountAuthorityFloorProjection(
  client: PoolClient,
  resources: ReadonlyArray<{ kind: AccountAuthorityTombstoneKind; resourceId: string }>,
  authorityGeneration: number,
  companionLineageId?: string,
  companionReaddDecisionId?: string,
): Promise<void> {
  for (const resource of resources) {
    if (resource.kind === 'recovery_credential') {
      throw new Error('Recovery credential floors cannot enter the database projection');
    }
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
        (kind, resource_hash, authority_generation, companion_lineage_id,
         companion_readd_decision_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (kind, resource_hash) DO UPDATE
      SET authority_generation = EXCLUDED.authority_generation,
          companion_lineage_id = EXCLUDED.companion_lineage_id,
          companion_readd_decision_id = EXCLUDED.companion_readd_decision_id
    `, [
      resource.kind,
      digest(resource.resourceId),
      authorityGeneration,
      resource.kind === 'companion_lineage_floor' ? companionLineageId : null,
      resource.kind === 'companion_lineage_floor' ? companionReaddDecisionId : null,
    ]);
  }
}
