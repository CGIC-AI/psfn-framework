import { describe, expect, it } from 'vitest';
import { createPostgresIntentionPortsFromPool } from './postgres-adapters.js';

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
  last_reviewed_at: string | null;
  next_review_at: string | null;
  merged_from_ids: unknown;
  split_from_id: string | null;
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

class FakeIntentionPool {
  private activeConcerns = new Map<string, ActiveConcernRow>();
  private pendingFollowUps = new Map<string, PendingFollowUpRow>();
  private pendingFollowUpQuarantine = new Map<string, PendingFollowUpQuarantineRow>();
  private behavioralPatternEvents = new Map<string, BehavioralPatternRow>();
  private ids = 1;

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

  async query<Row>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const normalized = text.replace(/\s+/g, ' ').trim();

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
        last_reviewed_at: lastReviewedAt,
        next_review_at: nextReviewAt,
        merged_from_ids: mergedFromIds,
        split_from_id: splitFromId,
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

    if (normalized.includes('FROM active_concerns') && normalized.includes('ORDER BY CASE priority')) {
      const filtersExpired = normalized.includes('expires_at >');
      const filtersResolved = normalized.includes('resolved_at IS NULL');
      const maybeAsOf = filtersExpired ? values[0] as string : undefined;
      const maybeContactId = values.length === (filtersExpired ? 3 : 2)
        ? values[filtersExpired ? 1 : 0]
        : undefined;
      const contactId = typeof maybeContactId === 'string' ? maybeContactId : undefined;
      const limit = Number(values[values.length - 1]);
      const rows = [...this.activeConcerns.values()]
        .filter((row) => !filtersResolved || row.resolved_at === null)
        .filter((row) => !filtersResolved || (row.status !== 'resolved' && row.status !== 'dismissed' && row.status !== 'suppressed'))
        .filter((row) => !maybeAsOf || row.expires_at > maybeAsOf)
        .filter((row) => !contactId || row.contact_id === null || row.contact_id === contactId)
        .sort((left, right) => concernSort(left, right))
        .slice(0, limit)
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.startsWith('UPDATE active_concerns')) {
      const row = this.activeConcerns.get(values[0] as string);
      if (!row) {
        return { rows: [] };
      }
      if (normalized.includes('SET status = $2')) {
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
        ] = values as [string, string, string | null, string | null, string, string | null, number, unknown, unknown];
        row.status = status;
        row.resolved_at = resolvedAt;
        row.resolution_outcome = resolutionOutcome;
        row.last_reviewed_at = lastReviewedAt;
        row.next_review_at = nextReviewAt;
        row.salience = salience;
        row.evidence_refs = evidenceRefs;
        row.resolution_evidence_refs = resolutionEvidenceRefs;
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
      ] = values as [string, string, string, string, number, string, string, unknown, string, string | null, unknown, string | null];
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
        activated_at: null,
        activation_reason: null,
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
      const rows = [...this.pendingFollowUps.values()]
        .filter(row => row.activated_at === null)
        .filter(row => !contactId || row.contact_id === null || row.contact_id === contactId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.startsWith('UPDATE intention_pending_follow_ups')) {
      const [id, activatedAt, activationReason] = values as [string, string, string | null];
      const row = this.pendingFollowUps.get(id);
      if (!row || row.activated_at !== null) {
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

    if (normalized.includes('GROUP BY strategy') && normalized.includes('FROM behavioral_pattern_events')) {
      const [contactId, minResolvedCount, limit] = values as [string, number, number];
      const grouped = groupBehavioralEvents([...this.behavioralPatternEvents.values()].filter(row => row.contact_id === contactId));
      const rows = grouped
        .filter(row => row.resolved_count >= Number(minResolvedCount))
        .sort((left, right) => right.average_outcome - left.average_outcome || right.resolved_count - left.resolved_count || left.strategy.localeCompare(right.strategy))
        .slice(0, Number(limit))
        .map(row => row as Row);
      return { rows };
    }

    if (normalized.includes('SELECT promoted_memory_id') && normalized.includes('FROM behavioral_pattern_events')) {
      return { rows: [] };
    }

    if (normalized.includes('FROM behavioral_pattern_events') && normalized.includes('WHERE contact_id = $1 AND strategy = $2')) {
      const [contactId, strategy] = values as [string, string];
      const rows = groupBehavioralEvents([...this.behavioralPatternEvents.values()].filter(row => row.contact_id === contactId && row.strategy === strategy));
      return { rows: rows.length > 0 ? [rows[0] as Row] : [] };
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

describe('postgres intention adapters', () => {
  it('persists concerns and resolves similar follow-up lookups', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never);

    const created = await ports.concernStore.create({
      text: 'Check hydration reminder',
      contactId: 'contact-a',
      source: 'agent',
    });
    expect(created.id).toBeTruthy();

    const active = await ports.concernStore.getActiveConcerns('contact-a');
    expect(active).toHaveLength(1);
    expect(ports.concernProvider.getActiveConcerns('contact-a')).toHaveLength(1);
    expect(active[0]).toMatchObject({
      text: 'Check hydration reminder',
      contactId: 'contact-a',
      priority: 'medium',
      source: 'agent',
      status: 'active',
    });

    const duplicate = await ports.concernStore.create({
      text: 'Check the hydration reminder',
      contactId: 'contact-a',
      priority: 'high',
      status: 'blocked',
      evidenceRefs: [{ kind: 'runtime', ref: 'pg-dedupe-1' }],
    });
    expect(duplicate.id).toBe(created.id);
    expect(duplicate).toMatchObject({
      priority: 'high',
      status: 'blocked',
      evidenceRefs: [{ kind: 'runtime', ref: 'pg-dedupe-1' }],
    });

    const resolved = await ports.concernStore.resolveConcern(created.id, {
      outcome: 'Handled already',
      resolvedAt: '2026-03-28T01:00:00.000Z',
    });
    expect(resolved?.resolutionOutcome).toBe('Handled already');
    expect(ports.concernProvider.getActiveConcerns('contact-a')).toEqual([]);

    const recent = await ports.concernStore.listRecentlyResolvedConcerns('contact-a', {
      asOf: '2026-03-28T02:00:00.000Z',
      withinMs: 4 * 60 * 60 * 1000,
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      id: created.id,
      resolvedAt: '2026-03-28T01:00:00.000Z',
    });

    const match = await ports.concernStore.findRecentlyResolvedSimilarConcern({
      text: 'Check the hydration reminder',
      contactId: 'contact-a',
      asOf: '2026-03-28T02:00:00.000Z',
      withinMs: 4 * 60 * 60 * 1000,
    });
    expect(match?.id).toBe(created.id);
  });

  it('resolves stale duplicate concerns before Postgres creation opens another thread', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never);

    const stale = await ports.concernStore.create({
      text: 'Follow up on hydration tomorrow morning',
      contactId: 'contact-a',
      status: 'watching',
      createdAt: '2026-03-28T00:00:00.000Z',
      expiresAt: '2026-03-28T01:00:00.000Z',
    });

    const duplicate = await ports.concernStore.create({
      text: 'Follow up on hydration tomorrow',
      contactId: 'contact-a',
      priority: 'high',
      createdAt: '2026-03-28T02:00:00.000Z',
      evidenceRefs: [{ kind: 'message', ref: 'msg-repeat-hydration' }],
    });

    expect(duplicate.id).toBe(stale.id);
    expect(duplicate.status).toBe('resolved');
    expect(duplicate.resolutionOutcome).toBe('Resolved as stale after review window elapsed.');
    await expect(ports.concernStore.getActiveConcerns('contact-a')).resolves.toEqual([]);
    await expect(ports.concernStore.list({
      contactId: 'contact-a',
      includeResolved: true,
      includeExpired: true,
    })).resolves.toHaveLength(1);
  });

  it('persists pending follow-ups and activation state', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never, {
      now: () => new Date('2026-03-28T02:00:00.000Z'),
    });

    const followUp = await ports.pendingFollowUpStore.enqueue({
      content: 'Check in tomorrow about medication.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-3',
      contextSummary: 'Medication check-in context',
      wakeConditions: ['next_user_turn'],
      dueAt: '2026-03-28T03:00:00.000Z',
    });
    expect(followUp).toMatchObject({
      content: 'Check in tomorrow about medication.',
      contactId: 'contact-a',
      sourceMessageId: 'msg-3',
      contextSummary: 'Medication check-in context',
      wakeConditions: ['next_user_turn'],
    });

    const pending = await ports.pendingFollowUpStore.list({ contactId: 'contact-a' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(followUp.id);

    const activated = await ports.pendingFollowUpStore.dequeue(followUp.id, {
      activationReason: 'post_turn_action',
      activatedAt: '2026-03-28T04:00:00.000Z',
    });
    expect(activated?.activatedAt).toBe('2026-03-28T04:00:00.000Z');
    expect(activated?.activationReason).toBe('post_turn_action');
  });

  it('filters stale pending follow-ups the same way for store and runtime provider access', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never, {
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    await ports.pendingFollowUpStore.enqueue({
      content: 'Age this out.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      createdAt: '2026-03-24T11:00:00.000Z',
    });
    await ports.pendingFollowUpStore.enqueue({
      content: 'Expire after the overdue window.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      createdAt: '2026-03-24T09:00:00.000Z',
      dueAt: '2026-03-24T10:30:00.000Z',
    });
    await ports.pendingFollowUpStore.enqueue({
      content: 'Keep this pending.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      createdAt: '2026-03-25T08:00:00.000Z',
      dueAt: '2026-03-25T18:00:00.000Z',
    });

    await expect(ports.pendingFollowUpStore.list({ contactId: 'contact-a' })).resolves.toEqual([
      expect.objectContaining({ content: 'Keep this pending.' }),
    ]);
    expect(ports.pendingFollowUpProvider.getPendingFollowUps('contact-a')).toEqual([
      expect.objectContaining({ content: 'Keep this pending.' }),
    ]);
    await expect(ports.pendingFollowUpStore.list({
      contactId: 'contact-a',
      includeExpired: true,
    })).resolves.toHaveLength(3);
  });

  it('quarantines invalid pending follow-up rows through the Postgres port', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never, {
      now: () => new Date('2026-03-28T02:00:00.000Z'),
      idFactory: () => 'follow-up-1',
    });

    await ports.pendingFollowUpStore.enqueue({
      content: 'Corrupt wake condition row.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      wakeConditions: ['next_user_turn'],
    });
    pool.corruptPendingFollowUp('follow-up-1', {
      wake_conditions: 'not-json',
    });

    await expect(ports.pendingFollowUpStore.list({ contactId: 'contact-a' })).resolves.toEqual([]);
    await expect(ports.pendingFollowUpStore.peek('follow-up-1')).resolves.toBeNull();
    await expect(ports.pendingFollowUpStore.listQuarantined()).resolves.toEqual([
      expect.objectContaining({
        followUpId: 'follow-up-1',
        source: 'list',
        reason: expect.stringContaining('wake_conditions'),
        raw: expect.objectContaining({
          id: 'follow-up-1',
          wake_conditions: 'not-json',
        }),
      }),
    ]);
  });

  it('tracks behavioral samples and summaries', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never);

    const sample = await ports.behavioralPatternTracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-1',
      responseContent: 'I hear you. Let us focus on the next step.',
    });
    expect(sample.strategy).toBe('empathy');

    const pending = await ports.behavioralPatternTracker.tryRecordOutcomeForLatestPending({
      contactId: 'contact-a',
      outcomeScore: 0.6,
      observedAt: '2026-03-28T05:00:00.000Z',
    });
    expect(pending?.outcomeScore).toBe(0.6);

    await ports.behavioralPatternTracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-2',
      responseContent: '```ts\nconst value = 1;\n```',
      strategy: 'technical',
    });
    await ports.behavioralPatternTracker.recordOutcomeForSample({
      contactId: 'contact-a',
      sourceMessageId: 'msg-2',
      strategy: 'technical',
      outcomeScore: 0.8,
      observedAt: '2026-03-28T06:00:00.000Z',
    });

    const summaries = await ports.behavioralPatternTracker.listStrategySummaries('contact-a');
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        strategy: 'empathy',
        resolvedCount: 1,
        pendingCount: 0,
      }),
      expect.objectContaining({
        strategy: 'technical',
        resolvedCount: 1,
        pendingCount: 0,
      }),
    ]));
  });
});
