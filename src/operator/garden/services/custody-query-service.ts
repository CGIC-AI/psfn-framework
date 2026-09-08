// ── Garden custody chain query service (psfn-framework-ccgdz.7) ──
//
// The operator-facing half of the custody seam. It answers the epic's two AC-3
// questions from persisted state alone, and it is the place where three rules
// are enforced before any row is read:
//
//   1. THE QUERY INPUT IS ITSELF CONTENT-FREE. A source is addressed by a
//      sha256 digest, or by a reference that matches the same bounded
//      identifier shape the custody records themselves are allowed to store.
//      Anything else is a 400, not a hashed-and-searched string — otherwise
//      the query string becomes a channel for smuggling prose into an audit
//      log that exists precisely to have none.
//   2. THE COMPANION BOUNDARY IS STRUCTURAL. The reader's pool belongs to one
//      companion, delivery rows are filtered by that companion's owner in SQL,
//      and a fleet request that names a different companion is refused before
//      the read (Invariant 11, `garden-companion-scope.ts`).
//   3. RESULTS ARE BOUNDED AND PAGEABLE. A source with a long history returns
//      one keyset page and a cursor, never the whole retention horizon.
//
// Everything the operator sees is produced by `custody-chain-query.ts`, which
// degrades every unreadable dimension to an explicit `unknown`.

import {
  decodeCustodyChainCursor,
  projectEgressToSources,
  projectSourceToEgresses,
  type CustodyChainDeliveryReadPort,
  type CustodyChainEgressToSourcesView,
  type CustodyChainSnapshotReadPort,
  type CustodyChainSourceToEgressesView,
} from '../../../core/cogsec/disclosure/custody-chain-query.js';
import {
  CUSTODY_SAFE_IDENTIFIER_PATTERN,
  custodyIdentity,
  custodyRefForTurn,
} from '../../../core/cogsec/disclosure/custody-identity.js';
import {
  resolveHealthEventOwner,
  type HealthEventOwner,
} from '../../../shared/contracts/health-event.js';
import { assertGardenRequestCompanionScope } from '../garden-companion-scope.js';
import type { GardenRequestContext } from '../garden-request-context.js';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/** `turn:<turnId>#<attempt digest>` — the delivery record's own composite key. */
const DELIVERY_REF_PATTERN = /^turn:[A-Za-z0-9_:.@+-]{1,128}#[a-f0-9]{64}$/u;

const CUSTODY_SOURCE_PAGE_SIZE_DEFAULT = 25;
const CUSTODY_SOURCE_PAGE_SIZE_MAX = 100;

/** A refusal the route turns into a 400; never carries the rejected value. */
export class CustodyQueryInputError extends Error {}

function invalidInput(message: string): CustodyQueryInputError {
  return new CustodyQueryInputError(message);
}

function singleParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length === 0) return null;
  if (values.length > 1) throw invalidInput(`${name} accepts a single value`);
  const trimmed = values[0]?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function parsePageSize(params: URLSearchParams): number {
  const raw = singleParam(params, 'limit');
  if (raw === null) return CUSTODY_SOURCE_PAGE_SIZE_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > CUSTODY_SOURCE_PAGE_SIZE_MAX) {
    throw invalidInput(
      `limit must be an integer between 1 and ${String(CUSTODY_SOURCE_PAGE_SIZE_MAX)}`,
    );
  }
  return parsed;
}

export interface AdminCustodyQueryService {
  /** "Which admitted message/context caused this egress?" */
  queryEgressChain(
    params: URLSearchParams,
    context?: GardenRequestContext,
  ): Promise<CustodyChainEgressToSourcesView>;
  /** "Where did this source's bytes end up?" */
  querySourceEgresses(
    params: URLSearchParams,
    context?: GardenRequestContext,
  ): Promise<CustodyChainSourceToEgressesView>;
}

export interface AdminCustodyQueryServiceOptions {
  readonly snapshots: CustodyChainSnapshotReadPort;
  readonly deliveries: CustodyChainDeliveryReadPort;
  /**
   * The companion whose stores this service was constructed over. Undefined
   * means the system owner — the same resolution the delivery recorder used
   * when it wrote the rows, so the query's owner predicate and the record's
   * owner column are produced by ONE function and cannot drift apart.
   */
  readonly companionId?: string | undefined;
}

export class GardenCustodyQueryService implements AdminCustodyQueryService {
  private readonly owner: HealthEventOwner;

  constructor(private readonly options: AdminCustodyQueryServiceOptions) {
    this.owner = resolveHealthEventOwner(options.companionId);
  }

  async queryEgressChain(
    params: URLSearchParams,
    context?: GardenRequestContext,
  ): Promise<CustodyChainEgressToSourcesView> {
    this.assertCompanionScope(context);
    const generationContextRef = await this.resolveGenerationContextRef(params);
    const [snapshot, manifest, deliveries] = await Promise.all([
      this.options.snapshots.resolveSnapshot(generationContextRef),
      this.options.snapshots.resolveContextManifest(generationContextRef),
      this.options.deliveries.listDeliveriesForGenerations({
        generationContextRefs: [generationContextRef],
        owner: this.owner,
      }),
    ]);
    return projectEgressToSources({
      generationContextRef,
      // The key IS `turn:<turnId>`, so the turn id is recovered from the key
      // rather than from a record that may not exist. A query for a turn with
      // no custody row still names the turn it found nothing for.
      turnId: generationContextRef.slice('turn:'.length),
      snapshot,
      manifest,
      deliveries,
    });
  }

  async querySourceEgresses(
    params: URLSearchParams,
    context?: GardenRequestContext,
  ): Promise<CustodyChainSourceToEgressesView> {
    this.assertCompanionScope(context);
    const source = this.resolveSourceIdentity(params);
    const limit = parsePageSize(params);
    const cursorRaw = singleParam(params, 'cursor');
    const cursor = cursorRaw === null ? null : decodeCustodyChainCursor(cursorRaw);
    if (cursorRaw !== null && cursor === null) {
      throw invalidInput('cursor is not a custody chain page cursor');
    }
    // Fetch one extra row to learn whether another page exists, without a
    // second count query that could disagree with the page it describes.
    const matches = await this.options.snapshots.listGenerationsBySourceDigest({
      sourceDigest: source.digest,
      limit: limit + 1,
      ...(cursor
        ? { beforeClassifiedAtMs: cursor.classifiedAtMs, beforeTurnId: cursor.turnId }
        : {}),
    });
    const hasMore = matches.length > limit;
    const page = hasMore ? matches.slice(0, limit) : matches;
    const deliveries = await this.options.deliveries.listDeliveriesForGenerations({
      generationContextRefs: page.map(match => match.generationContextRef),
      owner: this.owner,
    });
    return projectSourceToEgresses({ source, matches: page, deliveries, limit, hasMore });
  }

  /**
   * Invariant 11, asserted again at the service. The route dispatcher already
   * refuses a fleet context that names another companion; repeating it here
   * means a future caller that reaches the service by another path cannot
   * silently lose the boundary.
   */
  private assertCompanionScope(context: GardenRequestContext | undefined): void {
    if (!context) return;
    assertGardenRequestCompanionScope(context, this.options.companionId);
  }

  /**
   * Resolve the generation this query is about, from either the turn or a
   * specific delivery attempt.
   *
   * A `deliveryRef` is resolved through the delivery record so its owner is
   * checked: a record belonging to another companion reads as absent, exactly
   * as if it did not exist, rather than leaking its turn id through an error.
   */
  private async resolveGenerationContextRef(params: URLSearchParams): Promise<string> {
    const turnId = singleParam(params, 'turnId');
    const deliveryRef = singleParam(params, 'deliveryRef');
    if ((turnId === null) === (deliveryRef === null)) {
      throw invalidInput('Provide exactly one of turnId or deliveryRef');
    }
    if (turnId !== null) {
      if (!CUSTODY_SAFE_IDENTIFIER_PATTERN.test(turnId)) {
        throw invalidInput('turnId must be a bounded safe identifier');
      }
      return custodyRefForTurn(turnId);
    }
    if (deliveryRef === null || !DELIVERY_REF_PATTERN.test(deliveryRef)) {
      throw invalidInput('deliveryRef must be turn:<turnId>#<sha256>');
    }
    const resolved = await this.options.deliveries.resolveDelivery(deliveryRef);
    if (resolved.status === 'present' && !this.ownsRecord(resolved.record.owner)) {
      throw invalidInput('deliveryRef is not owned by this companion');
    }
    return deliveryRef.slice(0, deliveryRef.indexOf('#'));
  }

  private ownsRecord(owner: HealthEventOwner): boolean {
    if (owner.kind !== this.owner.kind) return false;
    return owner.kind !== 'companion'
      || this.owner.kind !== 'companion'
      || owner.companionId === this.owner.companionId;
  }

  /**
   * Address a source by digest, or by a reference bounded exactly as the
   * custody records bound theirs. `custodyIdentity` then produces the same
   * digest the write side stored, so the lookup key is derived by one
   * function on both sides.
   */
  private resolveSourceIdentity(params: URLSearchParams): { digest: string; id?: string } {
    const digest = singleParam(params, 'sourceDigest');
    const ref = singleParam(params, 'sourceRef');
    if ((digest === null) === (ref === null)) {
      throw invalidInput('Provide exactly one of sourceRef or sourceDigest');
    }
    if (digest !== null) {
      if (!SHA256_HEX_PATTERN.test(digest)) {
        throw invalidInput('sourceDigest must be 64 lowercase hex characters');
      }
      return { digest };
    }
    if (ref === null || !CUSTODY_SAFE_IDENTIFIER_PATTERN.test(ref)) {
      throw invalidInput('sourceRef must be a bounded safe identifier');
    }
    return custodyIdentity(ref);
  }
}
