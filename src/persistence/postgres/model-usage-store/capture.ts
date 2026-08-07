import type { Pool, PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { withPostgresClient } from '../../postgres.js';
import type {
  EnabledIcpCostBreakerPolicy,
  IcpConversationCostProjection,
  IcpConversationCostProjectionQuery,
  IcpConversationCostReservationInput,
  IcpConversationCostReservationReason,
  IcpConversationCostReservationResult,
  ModelUsageCostBreakdown,
  ModelUsageEvent,
  ModelUsageEventInput,
} from '../../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_UNKNOWN_DIMENSION,
  normalizeModelUsageAttribution,
} from '../../../shared/telemetry/model-usage-attribution.js';
import {
  ceilModelUsageUsd,
  reconcileModelUsageAccounting,
  roundModelUsageUsd,
} from '../../../shared/telemetry/model-usage-accounting.js';
import { boundModelUsageMetadata } from '../../../shared/telemetry/model-usage-metadata.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { parseIcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  asNumber,
  canonicalize,
  dayKey,
  inputNonNegativeCost,
  inputNonNegativeInteger,
  monthKey,
  nonNegativeCost,
  nonNegativeInteger,
  normalizeTelemetryVisibility,
  optionalText,
} from './common.js';
import type {
  IcpConversationCostProjectionRow,
  IcpConversationCostReservationRow,
} from './rows.js';

const log = createComponentLogger('ModelUsageStore');

export function normalizeText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}


export function validateEnabledIcpCostPolicy(
  policy: unknown,
): EnabledIcpCostBreakerPolicy {
  if (!isRecord(policy) || policy.enabled !== true) {
    throw new Error('ICP conversation cost accounting requires an enabled owner policy');
  }
  const warningThresholdUsd = inputNonNegativeCost(
    policy.warningThresholdUsd,
    'policy.warningThresholdUsd',
  );
  const hardLimitUsd = inputNonNegativeCost(policy.hardLimitUsd, 'policy.hardLimitUsd');
  const finalCloseoutReserveUsd = inputNonNegativeCost(
    policy.finalCloseoutReserveUsd,
    'policy.finalCloseoutReserveUsd',
  );
  if (
    warningThresholdUsd <= 0
    || finalCloseoutReserveUsd <= 0
    || Math.abs((warningThresholdUsd + finalCloseoutReserveUsd) - hardLimitUsd) > 1e-9
  ) {
    throw new Error('ICP conversation cost policy thresholds do not define one exact closeout band');
  }
  const pendingReservationStaleAfterMs = inputNonNegativeInteger(
    policy.pendingReservationStaleAfterMs,
    'policy.pendingReservationStaleAfterMs',
  );
  if (pendingReservationStaleAfterMs <= 0 || !isRecord(policy.includedCostPurposes)) {
    throw new Error('ICP conversation cost policy requires a positive stale interval and purpose map');
  }
  const includedCostPurposes = policy.includedCostPurposes;
  const purposeKeys = ['conversation_turn', 'tool', 'summary', 'extraction', 'sidecar'] as const;
  const conversationTurn = includedCostPurposes.conversation_turn;
  const tool = includedCostPurposes.tool;
  const summary = includedCostPurposes.summary;
  const extraction = includedCostPurposes.extraction;
  const sidecar = includedCostPurposes.sidecar;
  if (
    Object.keys(includedCostPurposes).some(
      key => !purposeKeys.some(purpose => purpose === key),
    )
    || typeof conversationTurn !== 'boolean'
    || typeof tool !== 'boolean'
    || typeof summary !== 'boolean'
    || typeof extraction !== 'boolean'
    || typeof sidecar !== 'boolean'
    || !conversationTurn
  ) {
    throw new Error('ICP conversation cost policy has an invalid includedCostPurposes map');
  }
  return {
    enabled: true,
    warningThresholdUsd,
    hardLimitUsd,
    finalCloseoutReserveUsd,
    pendingReservationStaleAfterMs,
    includedCostPurposes: {
      conversation_turn: conversationTurn,
      tool,
      summary,
      extraction,
      sidecar,
    },
  };
}

export function readIcpCostPurposeFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const icpCost = metadata.icpCost;
  if (!isRecord(icpCost) || typeof icpCost.purpose !== 'string') return undefined;
  return icpCost.purpose.trim() || undefined;
}

function mergeCostTotal(
  cost: ModelUsageCostBreakdown | undefined,
  total: number | undefined,
  field: string,
): ModelUsageCostBreakdown | undefined {
  if (!cost && total === undefined) return undefined;
  if (
    cost?.total !== undefined
    && total !== undefined
    && Math.round(cost.total * 1_000_000_000_000) !== Math.round(total * 1_000_000_000_000)
  ) {
    throw new Error(`${field}Usd must match the structured total`);
  }
  return {
    ...(cost ?? {}),
    ...(cost?.total === undefined && total !== undefined ? { total } : {}),
  };
}


export function eventFingerprint(event: ModelUsageEvent): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(event)))
    .digest('hex');
}

export function normalizeEvent(
  input: ModelUsageEventInput,
  expectedCompanionId?: string,
): ModelUsageEvent {
  const declaredCurrency = optionalText(input.currency)?.toUpperCase();
  if (declaredCurrency && declaredCurrency !== 'USD') {
    throw new Error('currency must be USD until explicit currency conversion is implemented');
  }
  const recordedAtMs = inputNonNegativeInteger(input.recordedAtMs, 'recordedAtMs', Date.now());
  const startedAtMs = inputNonNegativeInteger(input.startedAtMs, 'startedAtMs', recordedAtMs);
  const completedAtMs = input.completedAtMs !== undefined
    ? inputNonNegativeInteger(input.completedAtMs, 'completedAtMs')
    : undefined;
  const durationMs = input.durationMs !== undefined
    ? inputNonNegativeInteger(input.durationMs, 'durationMs')
    : (completedAtMs !== undefined ? Math.max(0, completedAtMs - startedAtMs) : undefined);
  const inputTokens = inputNonNegativeInteger(input.inputTokens, 'inputTokens');
  const outputTokens = inputNonNegativeInteger(input.outputTokens, 'outputTokens');
  const cacheReadTokens = inputNonNegativeInteger(input.cacheReadTokens, 'cacheReadTokens');
  const cacheWriteTokens = inputNonNegativeInteger(input.cacheWriteTokens, 'cacheWriteTokens');
  const providerCost = mergeCostTotal(input.providerCost, input.providerCostUsd, 'providerCost');
  const estimatedCost = mergeCostTotal(input.estimatedCost, input.estimatedCostUsd, 'estimatedCost');
  const effectiveCost = mergeCostTotal(input.effectiveCost, input.effectiveCostUsd, 'effectiveCost');
  const accounting = reconcileModelUsageAccounting({
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(input.totalTokens !== undefined ? { totalTokens: input.totalTokens } : {}),
    },
    ...(providerCost ? { providerCost } : {}),
    ...(estimatedCost ? { estimatedCost } : {}),
    ...(effectiveCost ? { effectiveCost } : {}),
    ...(input.costSource ? { costSource: input.costSource } : {}),
  });
  const providerCostUsd = accounting.providerCost.total;
  const estimatedCostUsd = accounting.estimatedCost.total;
  const effectiveCostUsd = accounting.effectiveCost.total;
  const logicalCallId = normalizeText(input.logicalCallId, `usage-${recordedAtMs}`);
  const attempt = inputNonNegativeInteger(input.attempt, 'attempt');
  const telemetryVisibility = normalizeTelemetryVisibility(input.telemetryVisibility);
  const operatorVisible = telemetryVisibility === 'operator_visible';
  const declaredCompanionId = optionalText(input.attribution.companionId);
  if (!expectedCompanionId && !declaredCompanionId) {
    throw new Error('Fleet model usage events require an explicit companionId attribution');
  }
  if (expectedCompanionId && declaredCompanionId && declaredCompanionId !== expectedCompanionId) {
    throw new Error(
      `Model usage companion attribution ${JSON.stringify(declaredCompanionId)} does not match `
      + `the store tenant ${JSON.stringify(expectedCompanionId)}`,
    );
  }
  const attribution = normalizeModelUsageAttribution({
    ...input.attribution,
    ...(expectedCompanionId ? { companionId: expectedCompanionId } : {}),
    // companion_private calls (e.g. blinded introspection audits) must not persist
    // turn/request/channel/tool linkage that could re-identify the private context.
    ...(operatorVisible
      ? {}
      : {
          turnId: undefined,
          requestId: undefined,
          channelId: undefined,
          toolName: undefined,
          toolCallId: undefined,
        }),
    // Embedding is the ledger origin even when it runs inside extraction or
    // retrieval request context. Preserve the enclosing session attribution,
    // but do not mislabel the metered model operation itself.
    ...(input.callKind === 'embedding' ? { originStage: 'embedding' } : {}),
  });

  return {
    id: normalizeText(input.id, `${logicalCallId}:${attempt}`),
    logicalCallId,
    attempt,
    recordedAtMs,
    startedAtMs,
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(input.ttftMs !== undefined ? { ttftMs: inputNonNegativeInteger(input.ttftMs, 'ttftMs') } : {}),
    dayKey: dayKey(recordedAtMs),
    monthKey: monthKey(recordedAtMs),
    status: input.status,
    settlement: input.settlement ?? (input.status === 'success' ? 'complete' : 'unknown'),
    callKind: input.callKind,
    telemetryVisibility,
    attribution,
    provider: normalizeText(input.provider, 'unknown'),
    model: normalizeText(input.model, 'unknown'),
    ...(optionalText(input.slotKey) ? { slotKey: optionalText(input.slotKey) } : {}),
    ...(optionalText(input.requestedProvider) ? { requestedProvider: optionalText(input.requestedProvider) } : {}),
    ...(optionalText(input.requestedModel) ? { requestedModel: optionalText(input.requestedModel) } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: accounting.usage.totalTokens,
    ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    ...(effectiveCostUsd !== undefined ? { effectiveCostUsd } : {}),
    providerCost: accounting.providerCost,
    estimatedCost: accounting.estimatedCost,
    effectiveCost: accounting.effectiveCost,
    costSource: accounting.costSource,
    ...(optionalText(declaredCurrency ?? accounting.effectiveCost.currency ?? accounting.providerCost.currency ?? accounting.estimatedCost.currency)
      ? { currency: optionalText(declaredCurrency ?? accounting.effectiveCost.currency ?? accounting.providerCost.currency ?? accounting.estimatedCost.currency) }
      : {}),
    ...(optionalText(input.stopReason) ? { stopReason: optionalText(input.stopReason) } : {}),
    ...(optionalText(input.errorCode) ? { errorCode: optionalText(input.errorCode) } : {}),
    ...(optionalText(input.errorMessage) ? { errorMessage: optionalText(input.errorMessage) } : {}),
    metadata: boundModelUsageMetadata(input.metadata),
  };
}

export class PostgresModelUsageCapture {
  constructor(
    private readonly pool: Pool,
    private readonly companionId: string | undefined,
    private readonly waitUntilReady: () => Promise<void>,
  ) {}

  private requireFleetIcpCostAccounting(): void {
    if (this.companionId !== undefined) {
      throw new Error('ICP conversation cost accounting requires the fleet-scoped model usage store');
    }
  }

  private async lockIcpConversation(client: PoolClient, conversationId: string): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 1347240271))',
      [conversationId],
    );
  }

  private async assertIcpConversationRoot(
    client: PoolClient,
    conversationId: string,
    rootInitiationId: string,
  ): Promise<void> {
    const conflicting = await client.query<{ root_initiation_id: string }>(`
      SELECT root_initiation_id
      FROM icp_conversation_cost_reservations
      WHERE conversation_id = $1 AND root_initiation_id <> $2
      UNION ALL
      SELECT root_initiation_id
      FROM model_usage_events
      WHERE conversation_id = $1
        AND root_initiation_id <> $2
        AND metadata_json -> 'icpCost' ->> 'purpose' IN (
          'conversation_turn', 'tool', 'summary', 'extraction', 'sidecar'
        )
      LIMIT 1
    `, [conversationId, rootInitiationId]);
    if (conflicting.rows.length > 0) {
      throw new Error('ICP conversation cost accounting detected conflicting root initiation identity');
    }
  }

  private async queryIcpConversationCostProjection(
    client: PoolClient,
    query: IcpConversationCostProjectionQuery,
  ): Promise<IcpConversationCostProjection> {
    const policy = validateEnabledIcpCostPolicy(query.policy);
    const nowMs = inputNonNegativeInteger(query.nowMs, 'nowMs', Date.now());
    const includedPurposes = Object.entries(policy.includedCostPurposes)
      .filter(([, included]) => included)
      .map(([purpose]) => purpose);
    const row = (await client.query<IcpConversationCostProjectionRow>(`
      WITH matching_events AS (
        SELECT companion_id, effective_cost_usd, currency
        FROM model_usage_events
        WHERE conversation_id = $1
          AND root_initiation_id = $2
          AND shard_id = 'unknown'
          AND subagent_id = 'unknown'
          AND metadata_json -> 'icpCost' ->> 'purpose' = ANY($3::text[])
      ),
      matching_reservations AS (
        SELECT companion_id, projected_cost_usd, status, created_at_ms
        FROM icp_conversation_cost_reservations
        WHERE conversation_id = $1
          AND root_initiation_id = $2
          AND cost_purpose = ANY($3::text[])
      ),
      event_totals AS (
        SELECT
          COALESCE(SUM(effective_cost_usd) FILTER (
            WHERE effective_cost_usd IS NOT NULL AND currency = 'USD'
          ), 0) AS actual_cost_usd,
          COUNT(*) AS actual_attempt_count,
          COUNT(*) FILTER (
            WHERE effective_cost_usd IS NULL OR currency IS DISTINCT FROM 'USD'
          ) AS unknown_cost_attempt_count
        FROM matching_events
      ),
      reservation_totals AS (
        SELECT
          COALESCE(SUM(projected_cost_usd) FILTER (
            WHERE status IN ('pending', 'settled_unknown')
          ), 0) AS pending_projected_cost_usd,
          COUNT(*) FILTER (WHERE status IN ('pending', 'settled_unknown')) AS pending_reservation_count,
          COUNT(*) FILTER (
            WHERE status IN ('pending', 'settled_unknown') AND created_at_ms < $4
          ) AS stale_reservation_count,
          COUNT(*) FILTER (WHERE status IN ('settled', 'settled_unknown')) AS settled_reservation_count
        FROM matching_reservations
      ),
      companions AS (
        SELECT companion_id FROM matching_events
        UNION
        SELECT companion_id FROM matching_reservations
      )
      SELECT
        event_totals.*,
        reservation_totals.*,
        (SELECT COUNT(*) FROM companions) AS attributed_companion_count
      FROM event_totals, reservation_totals
    `, [
      query.conversationId,
      query.rootInitiationId,
      includedPurposes,
      Math.max(0, nowMs - policy.pendingReservationStaleAfterMs),
    ])).rows.at(0);
    if (!row) {
      throw new Error('ICP conversation cost projection query returned no aggregate row');
    }
    const actualCostUsd = ceilModelUsageUsd(nonNegativeCost(row.actual_cost_usd) ?? 0);
    const pendingProjectedCostUsd = ceilModelUsageUsd(
      nonNegativeCost(row.pending_projected_cost_usd) ?? 0,
    );
    const projectedTotalCostUsd = ceilModelUsageUsd(actualCostUsd + pendingProjectedCostUsd);
    const unknownCostAttemptCount = nonNegativeInteger(row.unknown_cost_attempt_count);
    const enforcementState = unknownCostAttemptCount > 0
      ? 'unknown_cost'
      : projectedTotalCostUsd > policy.hardLimitUsd
        ? 'hard_stop'
        : projectedTotalCostUsd > policy.warningThresholdUsd
          ? 'warning'
          : 'normal';
    return {
      conversationId: query.conversationId,
      rootInitiationId: query.rootInitiationId,
      actualCostUsd,
      pendingProjectedCostUsd,
      projectedTotalCostUsd,
      warningThresholdUsd: policy.warningThresholdUsd,
      hardLimitUsd: policy.hardLimitUsd,
      remainingToHardLimitUsd: roundModelUsageUsd(
        Math.max(0, policy.hardLimitUsd - projectedTotalCostUsd),
      ),
      actualAttemptCount: nonNegativeInteger(row.actual_attempt_count),
      unknownCostAttemptCount,
      pendingReservationCount: nonNegativeInteger(row.pending_reservation_count),
      staleReservationCount: nonNegativeInteger(row.stale_reservation_count),
      settledReservationCount: nonNegativeInteger(row.settled_reservation_count),
      attributedCompanionCount: nonNegativeInteger(row.attributed_companion_count),
      enforcementState,
    };
  }

  private async recordIcpConversationCostDecision(
    client: PoolClient,
    input: {
      logicalCallId: string;
      attempt: number;
      recordedAtMs: number;
      companionId: string;
      costPurpose: string;
      closeoutEligible: boolean;
      allowed: boolean;
      replayed: boolean;
      reason: IcpConversationCostReservationReason;
      projectedRequestCostUsd: number;
      projectedTotalAfterAttemptUsd: number;
      projection: IcpConversationCostProjection;
    },
  ): Promise<void> {
    await client.query(`
      INSERT INTO icp_conversation_cost_decisions (
        decision_id, recorded_at_ms, logical_call_id, attempt, conversation_id,
        root_initiation_id, companion_id, cost_purpose, closeout_eligible,
        allowed, replayed, reason, projected_request_cost_usd, actual_cost_usd,
        pending_projected_cost_usd, projected_total_cost_usd,
        unknown_cost_attempt_count, warning_threshold_usd, hard_limit_usd
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19
      )
    `, [
      randomUUID(),
      input.recordedAtMs,
      input.logicalCallId,
      input.attempt,
      input.projection.conversationId,
      input.projection.rootInitiationId,
      input.companionId,
      input.costPurpose,
      input.closeoutEligible,
      input.allowed,
      input.replayed,
      input.reason,
      input.projectedRequestCostUsd,
      input.projection.actualCostUsd,
      input.projection.pendingProjectedCostUsd,
      input.projectedTotalAfterAttemptUsd,
      input.projection.unknownCostAttemptCount,
      input.projection.warningThresholdUsd,
      input.projection.hardLimitUsd,
    ]);
  }

  async getIcpConversationCostProjection(
    query: IcpConversationCostProjectionQuery,
  ): Promise<IcpConversationCostProjection> {
    this.requireFleetIcpCostAccounting();
    await this.waitUntilReady();
    const conversationId = normalizeText(query.conversationId, '');
    const rootInitiationId = normalizeText(query.rootInitiationId, '');
    if (!conversationId || !rootInitiationId) {
      throw new Error('ICP conversation cost projection requires conversation and root initiation ids');
    }
    return await withPostgresClient(this.pool, async (client) => {
      await this.lockIcpConversation(client, conversationId);
      await this.assertIcpConversationRoot(client, conversationId, rootInitiationId);
      return await this.queryIcpConversationCostProjection(client, {
        ...query,
        conversationId,
        rootInitiationId,
      });
    });
  }

  async reserveIcpConversationCost(
    input: IcpConversationCostReservationInput,
  ): Promise<IcpConversationCostReservationResult> {
    this.requireFleetIcpCostAccounting();
    await this.waitUntilReady();
    const policy = validateEnabledIcpCostPolicy(input.policy);
    const correlation = parseIcpConversationCorrelation(input.correlation);
    if (!policy.includedCostPurposes[correlation.costPurpose]) {
      throw new Error(`ICP cost purpose ${correlation.costPurpose} is excluded by owner policy`);
    }
    const logicalCallId = normalizeText(input.logicalCallId, '');
    if (!logicalCallId) throw new Error('ICP cost reservation requires logicalCallId');
    const attempt = inputNonNegativeInteger(input.attempt, 'attempt');
    const projectedCostUsd = ceilModelUsageUsd(inputNonNegativeCost(
      input.projectedCostUsd,
      'projectedCostUsd',
    ));
    const requestedAtMs = inputNonNegativeInteger(input.requestedAtMs, 'requestedAtMs', Date.now());
    const closeoutEligible = correlation.costPurpose === 'conversation_turn'
      && correlation.fatigueDecision === 'allow_overcharge';

    return await withPostgresClient(this.pool, async (client) => {
      await this.lockIcpConversation(client, correlation.conversationId);
      await this.assertIcpConversationRoot(
        client,
        correlation.conversationId,
        correlation.rootInitiationId,
      );
      const existing = (await client.query<IcpConversationCostReservationRow>(`
        SELECT *
        FROM icp_conversation_cost_reservations
        WHERE logical_call_id = $1 AND attempt = $2
        FOR UPDATE
      `, [logicalCallId, attempt])).rows.at(0);
      if (existing) {
        if (
          existing.conversation_id !== correlation.conversationId
          || existing.root_initiation_id !== correlation.rootInitiationId
          || existing.companion_id !== correlation.localCompanionId
          || existing.cost_purpose !== correlation.costPurpose
          || existing.closeout_eligible !== closeoutEligible
          || Math.abs(asNumber(existing.projected_cost_usd) - projectedCostUsd) > 1e-12
        ) {
          throw new Error('ICP cost reservation identity conflicts with an existing physical attempt');
        }
        const projection = await this.queryIcpConversationCostProjection(client, {
          conversationId: correlation.conversationId,
          rootInitiationId: correlation.rootInitiationId,
          policy,
          nowMs: requestedAtMs,
        });
        const allowed = existing.status === 'pending';
        const reason: IcpConversationCostReservationReason = existing.status === 'settled_unknown'
          ? 'unknown_historical_cost'
          : existing.status === 'settled'
            ? 'attempt_already_settled'
            : existing.reservation_reason;
        await this.recordIcpConversationCostDecision(client, {
          logicalCallId,
          attempt,
          recordedAtMs: requestedAtMs,
          companionId: correlation.localCompanionId,
          costPurpose: correlation.costPurpose,
          closeoutEligible,
          allowed,
          replayed: true,
          reason,
          projectedRequestCostUsd: projectedCostUsd,
          projectedTotalAfterAttemptUsd: projection.projectedTotalCostUsd,
          projection,
        });
        return {
          allowed,
          replayed: true,
          reason,
          projectedRequestCostUsd: projectedCostUsd,
          projection,
        };
      }

      const before = await this.queryIcpConversationCostProjection(client, {
        conversationId: correlation.conversationId,
        rootInitiationId: correlation.rootInitiationId,
        policy,
        nowMs: requestedAtMs,
      });
      const projectedTotalAfterAttemptUsd = ceilModelUsageUsd(
        before.projectedTotalCostUsd + projectedCostUsd,
      );
      let allowed = true;
      let reason: IcpConversationCostReservationReason = 'below_warning';
      if (before.unknownCostAttemptCount > 0) {
        allowed = false;
        reason = 'unknown_historical_cost';
      } else if (projectedTotalAfterAttemptUsd > policy.hardLimitUsd) {
        allowed = false;
        reason = 'hard_limit_exceeded';
      } else if (!closeoutEligible && projectedTotalAfterAttemptUsd > policy.warningThresholdUsd) {
        allowed = false;
        reason = 'warning_closeout_reserve_only';
      } else if (closeoutEligible && projectedTotalAfterAttemptUsd > policy.warningThresholdUsd) {
        reason = 'final_closeout_reserve';
      }

      let projection = before;
      if (allowed) {
        await client.query(`
          INSERT INTO icp_conversation_cost_reservations (
            logical_call_id, attempt, conversation_id, root_initiation_id,
            companion_id, cost_purpose, closeout_eligible, projected_cost_usd,
            status, reservation_reason, created_at_ms
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
        `, [
          logicalCallId,
          attempt,
          correlation.conversationId,
          correlation.rootInitiationId,
          correlation.localCompanionId,
          correlation.costPurpose,
          closeoutEligible,
          projectedCostUsd,
          reason,
          requestedAtMs,
        ]);
        projection = await this.queryIcpConversationCostProjection(client, {
          conversationId: correlation.conversationId,
          rootInitiationId: correlation.rootInitiationId,
          policy,
          nowMs: requestedAtMs,
        });
      }
      await this.recordIcpConversationCostDecision(client, {
        logicalCallId,
        attempt,
        recordedAtMs: requestedAtMs,
        companionId: correlation.localCompanionId,
        costPurpose: correlation.costPurpose,
        closeoutEligible,
        allowed,
        replayed: false,
        reason,
        projectedRequestCostUsd: projectedCostUsd,
        projectedTotalAfterAttemptUsd,
        projection,
      });
      return {
        allowed,
        replayed: false,
        reason,
        projectedRequestCostUsd: projectedCostUsd,
        projection,
      };
    });
  }

  async recordUsageEvent(input: ModelUsageEventInput): Promise<void> {
    const event = normalizeEvent(input, this.companionId);
    await this.waitUntilReady();
    await withPostgresClient(this.pool, async (client) => {
      const initialReservation = (await client.query<IcpConversationCostReservationRow>(`
        SELECT *
        FROM icp_conversation_cost_reservations
        WHERE logical_call_id = $1 AND attempt = $2
      `, [event.logicalCallId, event.attempt])).rows.at(0);
      let reservationForSettlement: IcpConversationCostReservationRow | undefined;
      if (initialReservation) {
        await this.lockIcpConversation(client, initialReservation.conversation_id);
        const lockedReservation = (await client.query<IcpConversationCostReservationRow>(`
          SELECT *
          FROM icp_conversation_cost_reservations
          WHERE logical_call_id = $1 AND attempt = $2
          FOR UPDATE
        `, [event.logicalCallId, event.attempt])).rows.at(0);
        const icpCostPurpose = readIcpCostPurposeFromMetadata(event.metadata);
        if (
          !lockedReservation
          || lockedReservation.conversation_id !== event.attribution.conversationId
          || lockedReservation.root_initiation_id !== event.attribution.rootInitiationId
          || lockedReservation.companion_id !== event.attribution.companionId
          || lockedReservation.cost_purpose !== icpCostPurpose
          || event.attribution.shardId !== MODEL_USAGE_UNKNOWN_DIMENSION
          || event.attribution.subagentId !== MODEL_USAGE_UNKNOWN_DIMENSION
        ) {
          throw new Error('Model usage event does not match its canonical ICP cost reservation');
        }
        reservationForSettlement = lockedReservation;
      }

      const inserted = (await client.query<{ id: string }>(`
      INSERT INTO model_usage_events (
        id, logical_call_id, attempt, recorded_at_ms, started_at_ms, completed_at_ms,
        duration_ms, ttft_ms, day_key, month_key, status, settlement, call_kind, call_type,
        purpose, origin_type, origin_stage, service, process, companion_id, session_id,
        turn_id, request_id, channel_id, channel_type, tool_name, tool_call_id,
        charge_lane, charge_surface, charge_event_id, charge_run_id, charge_root_run_id, charge_parent_run_id,
        shard_id, subagent_id, conversation_id, root_initiation_id, workload_type, workload_id,
        provider, model,
        slot_key, requested_provider, requested_model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens,
        provider_input_cost_usd, provider_output_cost_usd,
        provider_cache_read_cost_usd, provider_cache_write_cost_usd, provider_cost_usd,
        estimated_input_cost_usd, estimated_output_cost_usd,
        estimated_cache_read_cost_usd, estimated_cache_write_cost_usd, estimated_cost_usd,
        effective_input_cost_usd, effective_output_cost_usd,
        effective_cache_read_cost_usd, effective_cache_write_cost_usd, effective_cost_usd,
        cost_source, currency, stop_reason, error_code, error_message, metadata_json,
        event_fingerprint, telemetry_visibility, runtime_lane_class
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21,
        $22, $23, $24, $25, $26, $27,
        $28, $29, $30, $31, $32, $33,
        $34, $35, $36, $37, $38, $39,
        $40, $41,
        $42, $43, $44, $45, $46,
        $47, $48, $49,
        $50, $51, $52, $53, $54,
        $55, $56, $57, $58, $59,
        $60, $61, $62, $63, $64,
        $65, $66, $67, $68, $69, $70::jsonb,
        $71, $72, $73
      )
      ON CONFLICT (logical_call_id, attempt) DO UPDATE
        SET id = model_usage_events.id
        WHERE model_usage_events.event_fingerprint = EXCLUDED.event_fingerprint
      RETURNING id
    `, [
      event.id,
      event.logicalCallId,
      event.attempt,
      event.recordedAtMs,
      event.startedAtMs,
      event.completedAtMs ?? null,
      event.durationMs ?? null,
      event.ttftMs ?? null,
      event.dayKey,
      event.monthKey,
      event.status,
      event.settlement,
      event.callKind,
      event.attribution.callType,
      event.attribution.purpose,
      event.attribution.originType,
      event.attribution.originStage,
      event.attribution.service,
      event.attribution.process,
      event.attribution.companionId,
      event.attribution.sessionId,
      event.attribution.turnId,
      event.attribution.requestId,
      event.attribution.channelId,
      event.attribution.channelType,
      event.attribution.toolName,
      event.attribution.toolCallId,
      event.attribution.chargeLane,
      event.attribution.chargeSurface,
      event.attribution.chargeEventId,
      event.attribution.chargeRunId,
      event.attribution.chargeRootRunId,
      event.attribution.chargeParentRunId,
      event.attribution.shardId,
      event.attribution.subagentId,
      event.attribution.conversationId,
      event.attribution.rootInitiationId,
      event.attribution.workloadType,
      event.attribution.workloadId,
      event.provider,
      event.model,
      event.slotKey ?? MODEL_USAGE_UNKNOWN_DIMENSION,
      event.requestedProvider ?? MODEL_USAGE_UNKNOWN_DIMENSION,
      event.requestedModel ?? MODEL_USAGE_UNKNOWN_DIMENSION,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.totalTokens,
      event.providerCost.input ?? null,
      event.providerCost.output ?? null,
      event.providerCost.cacheRead ?? null,
      event.providerCost.cacheWrite ?? null,
      event.providerCostUsd ?? null,
      event.estimatedCost.input ?? null,
      event.estimatedCost.output ?? null,
      event.estimatedCost.cacheRead ?? null,
      event.estimatedCost.cacheWrite ?? null,
      event.estimatedCostUsd ?? null,
      event.effectiveCost.input ?? null,
      event.effectiveCost.output ?? null,
      event.effectiveCost.cacheRead ?? null,
      event.effectiveCost.cacheWrite ?? null,
      event.effectiveCostUsd ?? null,
      event.costSource,
      event.currency ?? null,
      event.stopReason ?? null,
      event.errorCode ?? null,
      event.errorMessage ?? null,
      JSON.stringify(event.metadata),
      eventFingerprint(event),
      event.telemetryVisibility,
      event.attribution.runtimeLaneClass,
      ])).rows.at(0);
      if (!inserted) {
        throw new Error(
          `Model usage attempt ${event.logicalCallId}:${event.attempt} conflicts with an existing immutable model usage attempt`,
        );
      }
      if (reservationForSettlement) {
        const settlementKnown = event.settlement === 'complete'
          && event.effectiveCostUsd !== undefined
          && event.currency === 'USD';
        await client.query(`
          UPDATE icp_conversation_cost_reservations
          SET status = $3,
              settled_event_id = $4,
              settled_at_ms = $5
          WHERE logical_call_id = $1 AND attempt = $2
        `, [
          event.logicalCallId,
          event.attempt,
          settlementKnown ? 'settled' : 'settled_unknown',
          inserted.id,
          event.recordedAtMs,
        ]);
      }
    });
    if (event.attribution.chargeLane === MODEL_USAGE_UNKNOWN_DIMENSION) {
      log.warn('Model usage recorded with unknown charge-lane attribution', {
        reason: 'unknown_charge_lane',
        provider: event.provider,
        model: event.model,
        originStage: event.attribution.originStage,
        sessionAttribution: event.attribution.sessionId === MODEL_USAGE_UNKNOWN_DIMENSION
          ? 'unknown'
          : 'known',
      });
    }
  }
}
