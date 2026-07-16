import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  AccountAuthorityTombstone,
  AccountAuthorityTombstoneKind,
} from './authority-floor.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function replaceAccountAuthorityFloorProjection(
  client: PoolClient,
  tombstones: readonly AccountAuthorityTombstone[],
): Promise<void> {
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
  `);
  for (const tombstone of tombstones) {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
        (kind, resource_hash, authority_generation)
      VALUES ($1, $2, $3)
    `, [tombstone.kind, tombstone.resourceHash, tombstone.generation]);
  }
}

export async function appendAccountAuthorityFloorProjection(
  client: PoolClient,
  resources: ReadonlyArray<{ kind: AccountAuthorityTombstoneKind; resourceId: string }>,
  authorityGeneration: number,
): Promise<void> {
  for (const resource of resources) {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
        (kind, resource_hash, authority_generation)
      VALUES ($1, $2, $3)
      ON CONFLICT (kind, resource_hash) DO UPDATE
      SET authority_generation = EXCLUDED.authority_generation
    `, [resource.kind, digest(resource.resourceId), authorityGeneration]);
  }
}
