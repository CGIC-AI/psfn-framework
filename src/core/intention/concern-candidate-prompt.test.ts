import { describe, expect, it, vi } from 'vitest';
import { buildFreeTimeFramingPrompt } from '../scheduler/free-time.js';
import {
  applyConcernCandidateDecision,
  listPendingConcernCandidates,
  renderPendingConcernCandidatesSection,
} from './concern-candidate-prompt.js';
import type { ActiveConcern } from './concerns.js';

function concern(id: string, status: ActiveConcern['status'], createdAt: string): ActiveConcern {
  return {
    id,
    text: `text for ${id}`,
    priority: 'medium',
    source: 'appraisal',
    status,
    createdAt,
    expiresAt: '2026-09-30T00:00:00.000Z',
    salience: 0.5,
    sensitivity: 'personal',
    owner: 'companion',
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
    mergedFromIds: [],
  } as ActiveConcern;
}

describe('pending concern candidates', () => {
  it('lists only undecided candidates, newest first', async () => {
    const list = vi.fn(async () => [
      concern('active-1', 'active', '2026-09-23T12:00:00.000Z'),
      concern('candidate-old', 'candidate', '2026-09-22T12:00:00.000Z'),
      concern('candidate-new', 'candidate', '2026-09-23T11:00:00.000Z'),
    ]);
    await expect(listPendingConcernCandidates({ list })).resolves.toEqual([
      expect.objectContaining({ id: 'candidate-new', text: 'text for candidate-new' }),
      expect.objectContaining({ id: 'candidate-old' }),
    ]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ includeExpired: false, includeResolved: false }));
  });

  it('renders the decision affordance that fits each surface and nothing when none are pending', () => {
    const candidates = [{ id: 'c-1', text: 'Ask how the interview went', priority: 'high' as const, createdAt: '' }];
    expect(renderPendingConcernCandidatesSection([], 'orient_tool')).toBeNull();
    expect(renderPendingConcernCandidatesSection(candidates, 'orient_tool'))
      .toContain('orient action=transition_concern concernId=<id> status=active');
    expect(renderPendingConcernCandidatesSection(candidates, 'sleeptime_plan')).toContain('"concern_decisions"');
    const awareness = renderPendingConcernCandidatesSection(candidates, 'awareness_only')!;
    expect(awareness).toContain('- c-1 (high): Ask how the interview went');
    expect(awareness).not.toContain('orient action');
  });

  it('shows pending candidates in free time', () => {
    const prompt = buildFreeTimeFramingPrompt({
      seedText: 'You have some time to yourself.',
      pendingConcerns: renderPendingConcernCandidatesSection(
        [{ id: 'c-1', text: 'Ask how the interview went', priority: 'high', createdAt: '' }],
        'orient_tool',
      ),
    });
    expect(prompt).toContain('[Possible Concerns Waiting For You]');
    expect(prompt).toContain('Ask how the interview went');
  });

  it('applies a decision only to a candidate that is still pending', async () => {
    const transitionConcernStatus = vi.fn(async () => concern('c-1', 'active', ''));
    const store = {
      getById: vi.fn(async (id: string) => (id === 'c-1' ? concern('c-1', 'candidate', '') : concern(id, 'active', ''))),
      transitionConcernStatus,
    };
    const evidenceRef = { kind: 'runtime' as const, ref: 'sleeptime-review:a' };
    await expect(applyConcernCandidateDecision(store, { id: 'c-1', decision: 'keep', evidenceRef }))
      .resolves.toBe('kept');
    expect(transitionConcernStatus).toHaveBeenCalledWith('c-1', { status: 'active', evidenceRefs: [evidenceRef] });
    await expect(applyConcernCandidateDecision(store, { id: 'c-2', decision: 'let_go', evidenceRef }))
      .resolves.toBe('already_decided');
    expect(transitionConcernStatus).toHaveBeenCalledTimes(1);
  });
});
