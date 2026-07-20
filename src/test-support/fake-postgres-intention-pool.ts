interface QueryResult<Row> {
  rows: Row[];
}
interface ActiveConcernRow {
  id: string;
  text: string;
  priority: string;
  source: string;
  status: string | null;
  created_at: string;
  expires_at: string;
  salience: number | null;
  sensitivity: string | null;
  owner: string | null;
  evidence_refs: unknown;
  resolution_evidence_refs: unknown;
  resolved_at: string | null;
  resolution_outcome: string | null;
  contact_id: string | null;
  formation_vad: unknown;
  resolution_vad: unknown;
  resolution_generation_id: string | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  merged_from_ids: unknown;
  split_from_id: string | null;
  origin_icp_root_initiation_id: string | null;
  candidate_review_snapshot: unknown;
}

interface PendingFollowUpRow {
  id: string;
  content: string;
  priority: string;
  timing: string;
  created_at: string;
  channel_id: string;
  channel_type: string;
  author_id: string;
  author_name: string;
  due_at: string | null;
  contact_id: string | null;
  source_message_id: string | null;
  context_summary: string | null;
  wake_conditions: string | null;
  activated_at: string | null;
  activation_reason: string | null;
  dampened_at: string | null;
  dampening_reason: string | null;
  origin_icp_root_initiation_id: string | null;
}

interface PendingFollowUpQuarantineRow {
  id: string;
  follow_up_id: string | null;
  reason: string;
  source: string | null;
  raw_entry: string;
  quarantined_at: string;
}

interface BehavioralPatternRow {
  id: string;
  contact_id: string;
  source_message_id: string;
  strategy: string;
  response_excerpt: string;
  created_at: string;
  outcome_score: number | null;
  outcome_observed_at: string | null;
  outcome_source_message_id: string | null;
  promoted_at: string | null;
  promoted_memory_id: string | null;
}

export class FakeIntentionPool {
  private activeConcerns = new Map<string, ActiveConcernRow>();
  private pendingFollowUps = new Map<string, PendingFollowUpRow>();
  private pendingFollowUpQuarantine = new Map<string, PendingFollowUpQuarantineRow>();
  private behavioralPatternEvents = new Map<string, BehavioralPatternRow>();
  private ids = 1;

  corruptActiveConcern(
    id: string,
    patch: Partial<ActiveConcernRow>,
  ): void {
    const row = this.activeConcerns.get(id);
    if (!row) {
      throw new Error(`Missing fake active concern "${id}"`);
    }
    this.activeConcerns.set(id, {
      ...row,
      ...patch,
    });
  }

  corruptPendingFollowUp(
    id: string,
    patch: Partial<PendingFollowUpRow>,
  ): void {
    const row = this.pendingFollowUps.get(id);
    if (!row) {
      throw new Error(`Missing fake pending follow-up "${id}"`);
    }
    this.pendingFollowUps.set(id, {
      ...row,
      ...patch,
    });
  }

  async connect(): Promise<{
    query: FakeIntentionPool['query'];
    release(): void;
  }> {
    return {
      query: this.query.bind(this),
      release() {},
    };
  }

  async query<Row>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [] };
    }

    if (normalized.startsWith('INSERT INTO active_concerns')) {
      const [
        id,
        textValue,
        priority,
        source,
        status,
        createdAt,
        expiresAt,
        salience,
        sensitivity,
        owner,
        evidenceRefs,
        resolutionEvidenceRefs,
        resolvedAt,
        contactId,
        formationVAD,
        lastReviewedAt,
        nextReviewAt,
        mergedFromIds,
        splitFromId,
        originIcpRootInitiationId,
        candidateReviewSnapshot,
        resolutionGenerationId,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        string,
        unknown,
        unknown,
        string | null,
        string | null,
        unknown,
        string,
        string | null,
        unknown,
        string | null,
        string | null,
        unknown,
        string | null,
      ];
      this.activeConcerns.set(id, {
        id,
        text: textValue,
        priority,
        source,
        status,
        created_at: createdAt,
        expires_at: expiresAt,
        salience,
        sensitivity,
        owner,
        evidence_refs: evidenceRefs,
        resolution_evidence_refs: resolutionEvidenceRefs,
        resolved_at: resolvedAt,
        resolution_outcome: null,
        contact_id: contactId,
        formation_vad: formationVAD,
        resolution_vad: null,
        resolution_generation_id: resolutionGenerationId,
        last_reviewed_at: lastReviewedAt,
        next_review_at: nextReviewAt,
        merged_from_ids: mergedFromIds,
        split_from_id: splitFromId,
        origin_icp_root_initiation_id: originIcpRootInitiationId,
        candidate_review_snapshot: candidateReviewSnapshot,
      });
      return { rows: [this.activeConcerns.get(id)! as Row] };
    }

    if (normalized.includes('FROM active_concerns') && normalized.includes('WHERE id = $1')) {
      const [id] = values as [string];
      const row = this.activeConcerns.get(id);
      return { rows: row ? [row as Row] : [] };
    }

    if (normalized.includes('FROM active_concerns') && normalized.includes('ORDER BY resolved_at DESC')) {
      const [resolvedAfter, maybeContactId, maybeLimit] = values as [string, string | number, number | undefined];
      const contactId = typeof maybeLimit === 'number' ? (typeof maybeContactId === 'string' ? maybeContactId : undefined) : undefined;
      const limit = typeof maybeLimit === 'number' ? maybeLimit : Number(maybeContactId);
      const rows = [...this.activeConcerns.values()]
        .filter((row) => row.resolved_at !== null)
        .filter((row) => row.resolved_at !== null && row.resolved_at >= resolvedAfter)
        .filter((row) => !contactId || row.contact_id === null || row.contact_id === contactId)
        .sort((left, right) => (right.resolved_at ?? '').localeCompare(left.resolved_at ?? '') || (right.created_at.localeCompare(left.created_at)) || right.id.localeCompare(left.id))
        .slice(0, Number(limit))
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.includes('FROM active_concerns')
      && normalized.includes('ORDER BY CASE priority')
      && !normalized.includes("status IN ('active', 'watching', 'deferred', 'blocked')")) {
      const filtersExpired = normalized.includes('expires_at >');
      const filtersResolved = normalized.includes('resolved_at IS NULL');
      let cursor = 0;
      const maybeAsOf = filtersExpired ? values[cursor++] as string : undefined;
      const hardLifetimeCutoff = normalized.includes('created_at >')
        ? values[cursor++] as string
        : undefined;
      const maybeContactId = normalized.includes('contact_id IS NULL OR contact_id =')
        ? values[cursor++]
        : undefined;
      const contactId = typeof maybeContactId === 'string' ? maybeContactId : undefined;
      const limit = Number(values[cursor]);
      const offset = Number(values[cursor + 1] ?? 0);
      const rows = [...this.activeConcerns.values()]
        .filter((row) => !filtersResolved || row.resolved_at === null)
        .filter((row) => !filtersResolved || (row.status !== 'resolved' && row.status !== 'dismissed' && row.status !== 'suppressed'))
        .filter((row) => !maybeAsOf || row.expires_at > maybeAsOf)
        .filter((row) => !hardLifetimeCutoff || row.created_at > hardLifetimeCutoff)
        .filter((row) => !contactId || row.contact_id === null || row.contact_id === contactId)
        .sort((left, right) => concernSort(left, right))
        .slice(offset, offset + limit)
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.includes('FROM active_concerns')
      && normalized.includes("status IN ('active', 'watching', 'deferred', 'blocked')")) {
      const [asOf, hardLifetimeCutoff, maybeContactId] = values as [string, string, string | undefined];
      const rows = [...this.activeConcerns.values()]
        .filter(row => row.resolved_at === null)
        .filter(row => ['active', 'watching', 'deferred', 'blocked'].includes(row.status ?? 'active'))
        .filter(row => row.expires_at > asOf && row.created_at > hardLifetimeCutoff)
        .filter(row => !maybeContactId || row.contact_id === null || row.contact_id === maybeContactId)
        .sort((left, right) => concernSort(left, right))
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.startsWith('UPDATE active_concerns')) {
      const row = this.activeConcerns.get(values[0] as string);
      if (!row) {
        return { rows: [] };
      }
      if (normalized.includes('SET status = $2')) {
        const terminalTransition = normalized.includes("resolved_at IS NULL AND status NOT IN ('resolved', 'dismissed', 'suppressed')");
        const expectedStatus = values[11] as string | undefined;
        const expectedResolvedAt = values[12] as string | null | undefined;
        if (terminalTransition && (row.resolved_at !== null || ['resolved', 'dismissed', 'suppressed'].includes(row.status ?? 'active'))) {
          return { rows: [] };
        }
        if (!terminalTransition && expectedStatus !== undefined && row.status !== expectedStatus) {
          return { rows: [] };
        }
        if (!terminalTransition && normalized.includes('resolved_at = $13') && row.resolved_at !== expectedResolvedAt) {
          return { rows: [] };
        }
        const [
          ,
          status,
          resolvedAt,
          resolutionOutcome,
          lastReviewedAt,
          nextReviewAt,
          salience,
          evidenceRefs,
          resolutionEvidenceRefs,
          resolutionVAD,
          resolutionGenerationId,
        ] = values as [string, string, string | null, string | null, string, string | null, number, unknown, unknown, unknown, string | null];
        row.status = status;
        row.resolved_at = resolvedAt;
        row.resolution_outcome = resolutionOutcome;
        row.last_reviewed_at = lastReviewedAt;
        row.next_review_at = nextReviewAt;
        row.salience = salience;
        row.evidence_refs = evidenceRefs;
        row.resolution_evidence_refs = resolutionEvidenceRefs;
        row.resolution_vad = resolutionVAD;
        row.resolution_generation_id = resolutionGenerationId;
        if (status !== 'candidate') row.candidate_review_snapshot = null;
        return { rows: [row as Row] };
      }
      const [
        ,
        priority,
        status,
        expiresAt,
        salience,
        sensitivity,
        owner,
        evidenceRefs,
        lastReviewedAt,
        nextReviewAt,
        mergedFromIds,
        splitFromId,
        originIcpRootInitiationId,
      ] = values as [string, string, string, string, number, string, string, unknown, string, string | null, unknown, string | null, string | null];
      row.priority = priority;
      row.status = status;
      row.expires_at = expiresAt;
      row.salience = salience;
      row.sensitivity = sensitivity;
      row.owner = owner;
      row.evidence_refs = evidenceRefs;
      row.last_reviewed_at = lastReviewedAt;
      row.next_review_at = nextReviewAt;
      row.merged_from_ids = mergedFromIds;
      row.split_from_id = splitFromId;
      row.origin_icp_root_initiation_id = originIcpRootInitiationId;
      if (normalized.includes('resolved_at = NULL')) {
        row.resolved_at = null;
        row.resolution_outcome = null;
        row.resolution_vad = null;
        row.resolution_generation_id = null;
      }
      return { rows: [row as Row] };
    }

    if (normalized.startsWith('INSERT INTO intention_pending_follow_ups')) {
      const [
        id,
        content,
        priority,
        timing,
        createdAt,
        channelId,
        channelType,
        authorId,
        authorName,
        dueAt,
        contactId,
        sourceMessageId,
        contextSummary,
        wakeConditions,
        originIcpRootInitiationId,
      ] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      this.pendingFollowUps.set(id, {
        id,
        content,
        priority,
        timing,
        created_at: createdAt,
        channel_id: channelId,
        channel_type: channelType,
        author_id: authorId,
        author_name: authorName,
        due_at: dueAt,
        contact_id: contactId,
        source_message_id: sourceMessageId,
        context_summary: contextSummary,
        wake_conditions: wakeConditions,
        origin_icp_root_initiation_id: originIcpRootInitiationId,
        activated_at: null,
        activation_reason: null,
        dampened_at: null,
        dampening_reason: null,
      });
      return { rows: [this.pendingFollowUps.get(id)! as Row] };
    }

    if (normalized.startsWith('INSERT INTO intention_pending_follow_up_quarantine')) {
      const [id, followUpId, reason, source, rawEntry, quarantinedAt] = values as [
        string,
        string | null,
        string,
        string | null,
        string,
        string,
      ];
      this.pendingFollowUpQuarantine.set(id, {
        id,
        follow_up_id: followUpId,
        reason,
        source,
        raw_entry: rawEntry,
        quarantined_at: quarantinedAt,
      });
      return { rows: [this.pendingFollowUpQuarantine.get(id)! as Row] };
    }

    if (normalized.startsWith('DELETE FROM intention_pending_follow_ups')) {
      const [id] = values as [string];
      this.pendingFollowUps.delete(id);
      return { rows: [] };
    }

    if (normalized.includes('FROM intention_pending_follow_ups') && normalized.includes('WHERE id = $1')) {
      const [id] = values as [string];
      const row = this.pendingFollowUps.get(id);
      return { rows: row ? [row as Row] : [] };
    }

    if (normalized.includes('FROM intention_pending_follow_up_quarantine')) {
      const hasFollowUpIdFilter = normalized.includes('follow_up_id = $1');
      const hasSourceFilter = normalized.includes('source = $1') || normalized.includes('source = $2');
      const followUpId = hasFollowUpIdFilter ? values[0] as string : undefined;
      const sourceIndex = hasSourceFilter ? (hasFollowUpIdFilter ? 1 : 0) : -1;
      const source = sourceIndex >= 0 ? values[sourceIndex] as string : undefined;
      const limit = Number(values[values.length - 1]);
      const rows = [...this.pendingFollowUpQuarantine.values()]
        .filter(row => !followUpId || row.follow_up_id === followUpId)
        .filter(row => !source || row.source === source)
        .sort((left, right) => left.quarantined_at.localeCompare(right.quarantined_at) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.includes('FROM intention_pending_follow_ups') && normalized.includes('ORDER BY created_at ASC, id ASC')) {
      const [maybeContactId] = values as [string | undefined];
      const contactId = typeof maybeContactId === 'string' ? maybeContactId : undefined;
      const pendingOnly = normalized.includes('activated_at IS NULL');
      const excludesDampened = normalized.includes('dampened_at IS NULL');
      const rows = [...this.pendingFollowUps.values()]
        .filter(row => !pendingOnly || row.activated_at === null)
        .filter(row => !excludesDampened || row.dampened_at === null)
        .filter(row => !contactId || row.contact_id === null || row.contact_id === contactId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.startsWith('UPDATE intention_pending_follow_ups')) {
      if (normalized.includes('SET content = $2')) {
        const [
          id,
          content,
          priority,
          timing,
          channelId,
          channelType,
          authorId,
          authorName,
          dueAt,
          contactId,
          sourceMessageId,
          contextSummary,
          wakeConditions,
          originIcpRootInitiationId,
        ] = values as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ];
        const row = this.pendingFollowUps.get(id);
        if (!row || row.activated_at !== null || row.dampened_at !== null) {
          return { rows: [] };
        }
        row.content = content;
        row.priority = priority;
        row.timing = timing;
        row.channel_id = channelId;
        row.channel_type = channelType;
        row.author_id = authorId;
        row.author_name = authorName;
        row.due_at = dueAt;
        row.contact_id = contactId;
        row.source_message_id = sourceMessageId;
        row.context_summary = contextSummary;
        row.wake_conditions = wakeConditions;
        row.origin_icp_root_initiation_id = originIcpRootInitiationId;
        return { rows: [row as Row] };
      }
      if (normalized.includes('SET dampened_at = $2')) {
        const [id, dampenedAt, dampeningReason] = values as [string, string, string];
        const row = this.pendingFollowUps.get(id);
        if (!row || row.activated_at !== null || row.dampened_at !== null) {
          return { rows: [] };
        }
        row.dampened_at = dampenedAt;
        row.dampening_reason = dampeningReason;
        return { rows: [row as Row] };
      }
      const [id, activatedAt, activationReason] = values as [string, string, string | null];
      const row = this.pendingFollowUps.get(id);
      if (!row || row.activated_at !== null || row.dampened_at !== null) {
        return { rows: [] };
      }
      row.activated_at = activatedAt;
      row.activation_reason = activationReason;
      return { rows: [row as Row] };
    }

    if (normalized.startsWith('INSERT INTO behavioral_pattern_events')) {
      const [id, contactId, sourceMessageId, strategy, responseExcerpt, createdAt] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const key = `${contactId}:${sourceMessageId}:${strategy}`;
      const existing = this.behavioralPatternEvents.get(key);
      const row = existing ?? {
        id,
        contact_id: contactId,
        source_message_id: sourceMessageId,
        strategy,
        response_excerpt: responseExcerpt,
        created_at: createdAt,
        outcome_score: null,
        outcome_observed_at: null,
        outcome_source_message_id: null,
        promoted_at: null,
        promoted_memory_id: null,
      };
      row.response_excerpt = responseExcerpt;
      this.behavioralPatternEvents.set(key, row);
      return { rows: [row as Row] };
    }

    if (normalized.includes('FROM behavioral_pattern_events') && normalized.includes('WHERE contact_id = $1 AND source_message_id = $2')) {
      const [contactId, sourceMessageId, maybeStrategy] = values as [string, string, string | undefined];
      const rows = [...this.behavioralPatternEvents.values()]
        .filter(row => row.contact_id === contactId && row.source_message_id === sourceMessageId)
        .filter(row => !maybeStrategy || row.strategy === maybeStrategy)
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.includes('FROM behavioral_pattern_events') && normalized.includes('WHERE contact_id = $1 AND outcome_score IS NULL')) {
      const [contactId, maybeStrategy] = values as [string, string | undefined];
      const rows = [...this.behavioralPatternEvents.values()]
        .filter(row => row.contact_id === contactId && row.outcome_score === null)
        .filter(row => !maybeStrategy || row.strategy === maybeStrategy)
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
        .map(row => row as Row);
      return { rows: rows.slice(0, 1) };
    }

    if (normalized.startsWith('UPDATE behavioral_pattern_events SET outcome_score')) {
      const [id, outcomeScore, observedAt, outcomeSourceMessageId] = values as [string, number, string, string | null];
      const row = [...this.behavioralPatternEvents.values()].find(event => event.id === id);
      if (!row) {
        return { rows: [] };
      }
      row.outcome_score = outcomeScore;
      row.outcome_observed_at = observedAt;
      row.outcome_source_message_id = outcomeSourceMessageId;
      return { rows: [row as Row] };
    }

    if (normalized.includes('FROM behavioral_pattern_events') && normalized.includes('WHERE contact_id = $1') && normalized.includes('ORDER BY created_at DESC, id DESC') && normalized.includes('LIMIT $2')) {
      const [contactId, limit] = values as [string, number];
      const includePending = !normalized.includes('outcome_score IS NOT NULL');
      const rows = [...this.behavioralPatternEvents.values()]
        .filter(row => row.contact_id === contactId)
        .filter(row => includePending || row.outcome_score !== null)
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
        .slice(0, Number(limit))
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.includes('GROUP BY strategy') && normalized.includes('FROM behavioral_pattern_events')) {
      const [contactId] = values as [string];
      const strategy = normalized.includes('AND strategy = $2') ? String(values[1]) : undefined;
      const grouped = groupBehavioralEvents([...this.behavioralPatternEvents.values()]
        .filter(row => row.contact_id === contactId)
        .filter(row => !strategy || row.strategy === strategy));
      if (!normalized.includes('HAVING')) {
        return { rows: grouped.map(row => row as Row) };
      }
      const minResolvedCount = Number(values[1]);
      const limit = Number(values[2]);
      const rows = grouped
        .filter(row => row.resolved_count >= minResolvedCount)
        .sort((left, right) => right.average_outcome - left.average_outcome || right.resolved_count - left.resolved_count || left.strategy.localeCompare(right.strategy))
        .slice(0, limit)
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.includes('SELECT promoted_memory_id') && normalized.includes('FROM behavioral_pattern_events')) {
      const [contactId, strategy] = values as [string, string];
      const row = [...this.behavioralPatternEvents.values()]
        .filter(event => event.contact_id === contactId && event.strategy === strategy && event.promoted_at !== null)
        .sort((left, right) => (left.promoted_at ?? '').localeCompare(right.promoted_at ?? '')).at(0);
      return { rows: row ? [{ promoted_memory_id: row.promoted_memory_id } as Row] : [] };
    }

    if (normalized.startsWith('UPDATE behavioral_pattern_events SET promoted_at')) {
      const [promotedAt, promotedMemoryId, contactId, strategy] = values as [string, string | null, string, string];
      for (const row of this.behavioralPatternEvents.values()) {
        if (row.contact_id !== contactId || row.strategy !== strategy || row.promoted_at !== null || row.outcome_score === null) continue;
        row.promoted_at = promotedAt;
        row.promoted_memory_id ??= promotedMemoryId;
      }
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in FakeIntentionPool: ${normalized}`);
  }
}

function concernSort(left: ActiveConcernRow, right: ActiveConcernRow): number {
  const priorityRank = (value: string): number => {
    if (value === 'high') return 0;
    if (value === 'medium') return 1;
    return 2;
  };
  return (
    priorityRank(left.priority) - priorityRank(right.priority)
    || left.expires_at.localeCompare(right.expires_at)
    || left.created_at.localeCompare(right.created_at)
    || left.id.localeCompare(right.id)
  );
}

function groupBehavioralEvents(rows: BehavioralPatternRow[]): Array<{
  strategy: string;
  sample_count: number;
  resolved_count: number;
  pending_count: number;
  average_outcome: number | null;
  positive_count: number;
  negative_count: number;
  last_outcome_at: string | null;
}> {
  const summaries = new Map<string, {
    strategy: string;
    sample_count: number;
    resolved_count: number;
    pending_count: number;
    total_outcome: number;
    outcome_samples: number;
    positive_count: number;
    negative_count: number;
    last_outcome_at: string | null;
  }>();

  for (const row of rows) {
    const summary = summaries.get(row.strategy) ?? {
      strategy: row.strategy,
      sample_count: 0,
      resolved_count: 0,
      pending_count: 0,
      total_outcome: 0,
      outcome_samples: 0,
      positive_count: 0,
      negative_count: 0,
      last_outcome_at: null,
    };
    summary.sample_count += 1;
    if (row.outcome_score === null) {
      summary.pending_count += 1;
    } else {
      summary.resolved_count += 1;
      summary.total_outcome += row.outcome_score;
      summary.outcome_samples += 1;
      if (row.outcome_score > 0.1) summary.positive_count += 1;
      if (row.outcome_score < -0.1) summary.negative_count += 1;
      if (!summary.last_outcome_at || row.outcome_observed_at > summary.last_outcome_at) {
        summary.last_outcome_at = row.outcome_observed_at;
      }
    }
    summaries.set(row.strategy, summary);
  }

  return [...summaries.values()].map(summary => ({
    strategy: summary.strategy,
    sample_count: summary.sample_count,
    resolved_count: summary.resolved_count,
    pending_count: summary.pending_count,
    average_outcome: summary.outcome_samples > 0 ? summary.total_outcome / summary.outcome_samples : null,
    positive_count: summary.positive_count,
    negative_count: summary.negative_count,
    last_outcome_at: summary.last_outcome_at,
  }));
}
