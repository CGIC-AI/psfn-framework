// ── Postgres read side of the custody chain (psfn-framework-ccgdz.7) ──
//
// `custody-snapshot-store.ts` and `egress-delivery-record-store.ts` are the
// turn's WRITE path: one row per generation, one row per egress attempt,
// first-write-wins, retention-bounded. This is the operator's READ path over
// the same three tables.
//
// It is a separate class rather than more methods on those stores for two
// reasons that both matter at runtime:
//   - The writers require an operator-declared retention horizon and prune on
//     write. A Garden read must never prune, and must not refuse to open
//     because a retention setting is missing.
//   - The writers' reads THROW on a row that fails its validator, which is
//     right for a store handing a record to a decision. It is wrong for an
//     audit query, where "this row does not validate" is the answer the
//     operator needs to see. Every method here returns a resolution instead.
//
// The validators themselves are reused unchanged — this module owns no parsing
// of its own, so a row that the writer would reject is a row this reader
// reports as `malformed`, never a shape only one of them believes in.
//
// INFRASTRUCTURE FAILURES STILL THROW. A dead pool, a missing table, or a
// syntax error is not an `unknown` chain; degrading those to `unknown` would
// let a broken database read as a clean audit.

import type { Pool, QueryResultRow } from 'pg';

import {
  validateContextSourceManifest,
  type ContextSourceManifest,
} from '../../core/cogsec/disclosure/context-source-manifest.js';
import type {
  CustodyChainDeliveryList,
  CustodyChainDeliveryReadPort,
  CustodyChainDerivedArtifactReadPort,
  CustodyChainDerivedArtifactView,
  CustodyChainGenerationMatch,
  CustodyChainResolution,
  CustodyChainSnapshotReadPort,
} from '../../core/cogsec/disclosure/custody-chain-query.js';
import { custodyIdentity } from '../../core/cogsec/disclosure/custody-identity.js';
import {
  validateCustodySnapshot,
  type CustodySnapshot,
} from '../../core/cogsec/disclosure/custody-snapshot.js';
import {
  validateEgressDeliveryRecord,
  type EgressDeliveryRecord,
} from '../../core/cogsec/disclosure/egress-delivery-record.js';
import type { HealthEventOwner } from '../../shared/contracts/health-event.js';
import { isRecord } from '../../shared/utils/types.js';
import { createPostgresPool, queryOne, queryRows } from '../postgres.js';

interface SnapshotRow extends QueryResultRow {
  snapshot_json: unknown;
}

interface ManifestRow extends QueryResultRow {
  manifest_json: unknown;
}

interface SnapshotMatchRow extends QueryResultRow {
  generation_context_ref: string;
  turn_id: string;
  classified_at_ms: string | number;
  snapshot_json: unknown;
}

interface DeliveryRow extends QueryResultRow {
  record_json: unknown;
}

/**
 * Resolve one stored document through its own validator.
 *
 * The `catch` is deliberately narrow in MEANING even though it is broad in
 * syntax: the only code it wraps is a pure validator over an already-fetched
 * JSON value, so the only error it can observe is a validation refusal. The
 * query that fetched the row is outside it and still throws.
 */
function resolveDocument<T>(
  document: unknown,
  validate: (value: unknown) => T,
): CustodyChainResolution<T> {
  try {
    return { status: 'present', record: validate(document) };
  } catch {
    return { status: 'malformed' };
  }
}

/** `bigint` columns arrive as strings on the wire; a row cannot be trusted. */
function readInstant(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Custody chain reader read an unusable instant: ${String(value)}`);
  }
  return parsed;
}

interface DerivedArtifactRow extends QueryResultRow {
  id: string;
  refs: unknown;
  consent_flags: unknown;
  provenance_json: unknown;
  retired: boolean;
}

/** Read one boolean out of a stored JSONB object without trusting its shape. */
function jsonBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'boolean' ? field : undefined;
}

/**
 * Fold one artifact's provenance refs into the three counts the custody view
 * shows. Unreadable entries are counted as neither runtime-authored nor
 * admitted: an unreadable ref proves nothing in either direction.
 */
function foldArtifactRefs(
  refs: unknown,
  turnId: string,
): Pick<
  CustodyChainDerivedArtifactView,
  'turnRefCount' | 'runtimeAuthoredSourceCount' | 'admittedSourceCount'
> {
  let turnRefCount = 0;
  let runtimeAuthoredSourceCount = 0;
  let admittedSourceCount = 0;
  for (const entry of Array.isArray(refs) ? refs : []) {
    if (!isRecord(entry)) continue;
    if (entry.envelopeId !== undefined || entry.receiptId !== undefined) {
      admittedSourceCount += 1;
    }
    const namesThisTurn = entry.refId === turnId || entry.turnId === turnId;
    if (!namesThisTurn) continue;
    turnRefCount += 1;
    if (entry.authoredBy === 'runtime') runtimeAuthoredSourceCount += 1;
  }
  return { turnRefCount, runtimeAuthoredSourceCount, admittedSourceCount };
}

export class PostgresCustodyChainReader
implements
  CustodyChainSnapshotReadPort,
  CustodyChainDeliveryReadPort,
  CustodyChainDerivedArtifactReadPort {
  private constructor(
    private readonly pool: Pool,
    private readonly ownsPool: boolean,
  ) {}

  /**
   * Opened by the persistence runtime with the SAME `schema`/`role` the custody
   * writer stores pin, so the reader and the turn look at one tenant boundary.
   * A reader on `public` while the turn writes to a companion schema would
   * report every real chain as absent — the one answer an audit surface must
   * never give wrongly.
   *
   * It deliberately runs NO migrations. The writer stores own this schema and
   * have already ensured it in this same process; a read-only surface that
   * creates tables would both contradict the deployment's "verify, never
   * repair" tenancy rule and, on a pinned tenant role, fail on a privilege it
   * has no business holding.
   */
  static connect(
    databaseUrl: string,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresCustodyChainReader> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'custody-chain-reader',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    return Promise.resolve(new PostgresCustodyChainReader(pool, true));
  }

  /** Test/embedding entry point: the caller owns the pool lifecycle. */
  static fromPool(pool: Pool): PostgresCustodyChainReader {
    return new PostgresCustodyChainReader(pool, false);
  }

  async resolveSnapshot(
    generationContextRef: string,
  ): Promise<CustodyChainResolution<CustodySnapshot>> {
    const row = await queryOne<SnapshotRow>(
      this.pool,
      'SELECT snapshot_json FROM custody_snapshots WHERE generation_context_ref = $1',
      [generationContextRef],
    );
    if (!row) return { status: 'absent' };
    return resolveDocument(row.snapshot_json, validateCustodySnapshot);
  }

  async resolveContextManifest(
    generationContextRef: string,
  ): Promise<CustodyChainResolution<ContextSourceManifest>> {
    const row = await queryOne<ManifestRow>(
      this.pool,
      'SELECT manifest_json FROM custody_context_manifests WHERE generation_context_ref = $1',
      [generationContextRef],
    );
    if (!row) return { status: 'absent' };
    return resolveDocument(row.manifest_json, validateContextSourceManifest);
  }

  /**
   * Which generations admitted this source?
   *
   * Containment (`@>`) on the snapshot's own `sources[].ref.digest` — the same
   * join key `custodyIdentity` mints on the write side, so the question is
   * answered from the record itself rather than from a parallel index that
   * could disagree with it. Backed by `idx_custody_snapshots_sources_gin`.
   *
   * Keyset paging on `(classified_at_ms, turn_id)` descending: a row-value
   * comparison, so a page boundary cannot repeat or skip a generation the way
   * an offset does when a concurrent turn writes.
   */
  async listGenerationsBySourceDigest(input: {
    readonly sourceDigest: string;
    readonly limit: number;
    readonly beforeClassifiedAtMs?: number;
    readonly beforeTurnId?: string;
  }): Promise<readonly CustodyChainGenerationMatch[]> {
    const containment = JSON.stringify({
      sources: [{ ref: { digest: input.sourceDigest } }],
    });
    const paged = input.beforeClassifiedAtMs !== undefined
      && input.beforeTurnId !== undefined;
    const rows = await queryRows<SnapshotMatchRow>(
      this.pool,
      `SELECT generation_context_ref, turn_id, classified_at_ms, snapshot_json
       FROM custody_snapshots
       WHERE snapshot_json @> $1::jsonb
       ${paged ? 'AND (classified_at_ms, turn_id) < ($3::bigint, $4::text)' : ''}
       ORDER BY classified_at_ms DESC, turn_id DESC
       LIMIT $2`,
      paged
        ? [containment, input.limit, input.beforeClassifiedAtMs, input.beforeTurnId]
        : [containment, input.limit],
    );
    return rows.map((row): CustodyChainGenerationMatch => ({
      generationContextRef: row.generation_context_ref,
      turnId: row.turn_id,
      classifiedAtMs: readInstant(row.classified_at_ms),
      snapshot: resolveDocument(row.snapshot_json, validateCustodySnapshot),
    }));
  }

  async resolveDelivery(
    deliveryRef: string,
  ): Promise<CustodyChainResolution<EgressDeliveryRecord>> {
    const row = await queryOne<DeliveryRow>(
      this.pool,
      'SELECT record_json FROM egress_delivery_records WHERE delivery_ref = $1',
      [deliveryRef],
    );
    if (!row) return { status: 'absent' };
    return resolveDocument(row.record_json, validateEgressDeliveryRecord);
  }

  /**
   * Delivery records for a bounded set of generations, owned by exactly one
   * owner.
   *
   * The owner predicate is part of the SQL, not a post-filter: a companion
   * boundary that is enforced after the rows are already in this process is a
   * boundary that a later refactor can drop without any test noticing.
   */
  async listDeliveriesForGenerations(input: {
    readonly generationContextRefs: readonly string[];
    readonly owner: HealthEventOwner;
  }): Promise<CustodyChainDeliveryList> {
    if (input.generationContextRefs.length === 0) {
      return { records: [], malformedCount: 0 };
    }
    const rows = await queryRows<DeliveryRow>(
      this.pool,
      `SELECT record_json FROM egress_delivery_records
       WHERE generation_context_ref = ANY($1::text[])
         AND owner_kind = $2
         AND owner_companion_id IS NOT DISTINCT FROM $3
       ORDER BY recorded_at_ms ASC, delivery_ref ASC`,
      [
        [...input.generationContextRefs],
        input.owner.kind,
        input.owner.kind === 'companion' ? input.owner.companionId : null,
      ],
    );
    const records: EgressDeliveryRecord[] = [];
    let malformedCount = 0;
    for (const row of rows) {
      const resolved = resolveDocument(row.record_json, validateEgressDeliveryRecord);
      if (resolved.status === 'present') records.push(resolved.record);
      else malformedCount += 1;
    }
    return { records, malformedCount };
  }

  /**
   * What did this generation leave behind — which episodes and memories were
   * derived from its turn (psfn-framework-ccgdz.8)?
   *
   * The custody records deliberately do not duplicate the memory and episodic
   * tables, so this is the one place the reader looks outside them. It is a
   * strictly read-only projection: ids, counts, and two booleans, no text, no
   * embedding, no scope.
   *
   * Episodes match on containment of a `{kind:'turn', refId}` provenance ref;
   * memories match on the turn their extraction recorded, either as the
   * provenance `turnId` or inside `sourceTurnIds`. Soft-deleted rows are
   * INCLUDED and flagged: a memory deleted under a consent withdrawal is
   * exactly the row an audit came to see, and hiding it would make the
   * withdrawal invisible at the moment it took effect.
   */
  async listDerivedArtifactsForGeneration(input: {
    readonly turnId: string;
    readonly limit: number;
  }): Promise<readonly CustodyChainDerivedArtifactView[]> {
    const [episodes, memories] = await Promise.all([
      queryRows<DerivedArtifactRow>(
        this.pool,
        `SELECT id, provenance_refs AS refs, consent_flags,
                '{}'::jsonb AS provenance_json,
                (status IN ('merged', 'superseded')) AS retired
         FROM l01_episodes
         WHERE provenance_refs @> $1::jsonb
         ORDER BY id ASC
         LIMIT $2`,
        [JSON.stringify([{ kind: 'turn', refId: input.turnId }]), input.limit],
      ),
      // A memory's structured refs live under `provenance_json.sourceAdmissions`
      // (ccgdz.3); its plain `provenance_refs` column is a list of display
      // strings and carries no identity, so it is deliberately not read here.
      queryRows<DerivedArtifactRow>(
        this.pool,
        `SELECT id,
                COALESCE(provenance_json -> 'sourceAdmissions', '[]'::jsonb) AS refs,
                consent_flags, provenance_json,
                (deleted_at IS NOT NULL OR superseded_by IS NOT NULL) AS retired
         FROM l2_memories
         WHERE provenance_json @> $1::jsonb OR provenance_json @> $2::jsonb
         ORDER BY id ASC
         LIMIT $3`,
        [
          JSON.stringify({ turnId: input.turnId }),
          JSON.stringify({ sourceTurnIds: [input.turnId] }),
          input.limit,
        ],
      ),
    ]);
    return [
      ...episodes.map(row => this.toDerivedArtifact(row, 'episode', input.turnId)),
      // A memory row matched on its own recorded turn, so its turn-ref count is
      // exactly one: it is derived from this generation by construction, and
      // its structured refs carry admission identity rather than turn ids.
      ...memories.map(row => ({
        ...this.toDerivedArtifact(row, 'memory', input.turnId),
        turnRefCount: 1,
      })),
    ];
  }

  private toDerivedArtifact(
    row: DerivedArtifactRow,
    kind: CustodyChainDerivedArtifactView['kind'],
    turnId: string,
  ): CustodyChainDerivedArtifactView {
    const producerId = isRecord(row.provenance_json)
      && isRecord(row.provenance_json.consentProducer)
      && typeof row.provenance_json.consentProducer.producerId === 'string'
      ? row.provenance_json.consentProducer.producerId
      : undefined;
    return {
      kind,
      id: custodyIdentity(row.id),
      ...foldArtifactRefs(row.refs, turnId),
      // Only an explicit `false` is a denial. An absent flag means nobody set
      // it, which the Layer-3 gate treats as "not denied" — the view must say
      // the same thing rather than inferring consent either way.
      consentDenied: jsonBoolean(row.consent_flags, 'allowRecall') === false,
      ...(producerId !== undefined ? { consentProducerId: producerId } : {}),
      retired: row.retired === true,
    };
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
