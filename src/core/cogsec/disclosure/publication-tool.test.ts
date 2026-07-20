// Regression coverage for the companion-owned publication edit-loop tool
// (jp36.7.3). Exercises the real custody service + approval queue + store, not
// mocks: schema rejects model-supplied disclosure metadata, submit round-trips
// runtime-derived metadata, status surfaces approval state, revise mints a fresh
// binding that invalidates the prior approval for the edited content, and the
// tool fails closed when custody / queue / lineage is absent.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmationQueue } from '../../../system/capabilities/confirmation-queue.js';
import {
  createApprovalQueuePortFromConfirmationQueue,
  type ApprovalQueuePort,
} from '../../../system/capabilities/approval-queue-port.js';
import type { AgentToolResult } from '../../../boundary/pi-agent/index.js';
import {
  createCapsuleCustodyService,
  createShareCapsuleCustodyStore,
  type CapsuleCustodyService,
  type ShareCapsuleCustodyStore,
} from './capsule-custody.js';
import type { DisclosureDestination, DisclosureLineage } from './contracts.js';
import type { ShareContent } from './capsule.js';
import { createPublicationTool, type PublicationToolDeps } from './publication-tool.js';

const NOW = 1_750_000_000_000;
const PUBLICATION_DESTINATION: DisclosureDestination = { kind: 'publication' };

const CLASSIFIED_LINEAGE: DisclosureLineage = {
  provenanceRefs: ['memory:7', 'session:free-time'],
  sourceSnapshots: [],
  effectiveSensitivity: 'intimate',
  permittedDestinations: [],
  subjectContactIds: ['contact-9'],
  sourceChannelIds: [],
  generationContextRef: 'turn:test',
  classification: 'approval_required',
  classifiedAt: new Date(NOW).toISOString(),
  classifierVersion: 'disclosure/v1',
  sourceCount: 2,
  hasUnclassifiedSource: false,
};

function resultText(result: AgentToolResult<{ isError?: boolean }>): string {
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function parseResult(result: AgentToolResult<{ isError?: boolean }>): Record<string, unknown> {
  return JSON.parse(resultText(result)) as Record<string, unknown>;
}

describe('createPublicationTool — companion-owned publication edit loop', () => {
  let dir: string;
  let filePath: string;
  let store: ShareCapsuleCustodyStore;
  let queue: ConfirmationQueue;
  let approvalQueue: ApprovalQueuePort;
  let custody: CapsuleCustodyService;
  let lineage: DisclosureLineage | undefined;
  let entrySeq: number;
  let capsuleSeq: number;
  let candidateSeq: number;
  let deps: PublicationToolDeps;

  const makeTool = (overrides: Partial<PublicationToolDeps> = {}) =>
    createPublicationTool({ ...deps, ...overrides });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publication-tool-'));
    filePath = join(dir, 'cogsec-share-capsules.json');
    store = createShareCapsuleCustodyStore(filePath, { now: () => NOW });
    entrySeq = 0;
    capsuleSeq = 0;
    candidateSeq = 0;
    queue = new ConfirmationQueue({ now: () => NOW, idFactory: () => `entry-${++entrySeq}` });
    approvalQueue = createApprovalQueuePortFromConfirmationQueue(queue);
    custody = createCapsuleCustodyService({
      store,
      approvalQueue,
      now: () => NOW,
      capsuleIdFactory: () => `cap-${++capsuleSeq}`,
    });
    lineage = CLASSIFIED_LINEAGE;
    deps = {
      getCustody: () => custody,
      getApprovalQueue: () => approvalQueue,
      getDisclosureLineage: () => lineage,
      now: () => NOW,
      candidateIdFactory: () => `cand-${++candidateSeq}`,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Model-forbidden disclosure metadata ────────────────────────────────────

  it.each([
    'sensitivity',
    'effectiveSensitivity',
    'provenanceRefs',
    'subjectContactIds',
    'audience',
    'destinations',
    'proposedDestinations',
    'contentHash',
    'capsuleId',
    'candidateId',
  ])('rejects model-supplied metadata param %s on submit', async (forbidden) => {
    const tool = makeTool();
    const result = await tool.execute('t', {
      action: 'submit',
      body: 'a reflection',
      reason: 'I want to share it',
      [forbidden]: 'x',
    });
    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('must not be supplied');
  });

  it('rejects forbidden metadata on revise as well', async () => {
    const tool = makeTool();
    const result = await tool.execute('t', {
      action: 'revise',
      revises_candidate_id: 'cand-1',
      body: 'edited',
      reason: 'r',
      provenanceRefs: ['memory:evil'],
    });
    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('must not be supplied');
  });

  // ── Submit round-trip on the real service ──────────────────────────────────

  it('submits a candidate whose disclosure metadata is derived from the runtime lineage, not the model', async () => {
    const tool = makeTool();
    const result = await tool.execute('t', {
      action: 'submit',
      body: 'An honest, exact sentence I authored.',
      reason: 'It captures something I want to publish.',
      media_refs: ['media:a'],
    });
    expect(result.details.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.status).toBe('pending_approval');
    expect(parsed.candidateId).toBe('cand-1');
    expect(parsed.effectiveSensitivity).toBe('intimate');

    const pending = approvalQueue.listPending();
    expect(pending).toHaveLength(1);
    const params = pending[0].params;
    expect(params.candidateId).toBe('cand-1');
    // Runtime authority: metadata comes from the folded lineage.
    expect(params.effectiveSensitivity).toBe('intimate');
    expect(params.provenanceRefs).toEqual(['memory:7', 'session:free-time']);
    expect(params.subjectContactIds).toEqual(['contact-9']);
    // Destination is the id-free publication surface; the model supplied no audience.
    expect(params.proposedDestinations).toEqual([{ kind: 'publication' }]);
  });

  it('operator approval mints a capsule bound to the exact submitted content', async () => {
    const tool = makeTool();
    const submit = parseResult(await tool.execute('t', {
      action: 'submit',
      body: 'exact body',
      reason: 'why',
    }));
    // Nothing minted before approval.
    expect(store.list()).toHaveLength(0);

    const resolve = await queue.resolve(
      { id: submit.approvalEntryId as string, decision: 'approve' },
      { kind: 'operator', id: 'pierre' },
    );
    expect(resolve.status).toBe('approved');

    const minted = store.getCapsuleState('cap-1');
    expect(minted?.capsule.content).toEqual({ body: 'exact body', mediaRefs: [] });
    expect(minted?.capsule.contentHash).toBe(submit.contentHash);
    expect(minted?.capsule.approval.actor).toBe('operator:pierre');
  });

  // ── Status / feedback surface ──────────────────────────────────────────────

  it('status surfaces pending and resolved publication candidates', async () => {
    const tool = makeTool();
    const submit = parseResult(await tool.execute('t', { action: 'submit', body: 'b1', reason: 'r1' }));

    let status = parseResult(await tool.execute('t', { action: 'status' }));
    expect(status.candidates).toMatchObject([{ candidateId: 'cand-1', status: 'pending_approval' }]);

    // Operator raises concerns by denying — the concern text itself is conveyed in conversation.
    await queue.resolve(
      { id: submit.approvalEntryId as string, decision: 'deny' },
      { kind: 'operator', id: 'pierre' },
    );
    status = parseResult(await tool.execute('t', { action: 'status' }));
    expect(status.candidates).toMatchObject([{ candidateId: 'cand-1', status: 'denied' }]);
  });

  it('defaults to the status action when none is given', async () => {
    const tool = makeTool();
    const parsed = parseResult(await tool.execute('t', {}));
    expect(parsed.action).toBe('status');
    expect(parsed.candidates).toEqual([]);
  });

  // ── Revise = fresh candidate; prior approval invalidated for the edit ───────

  it('revise generates a fresh candidate with a different hash and requires the prior candidate to exist', async () => {
    const tool = makeTool();
    const submit = parseResult(await tool.execute('t', { action: 'submit', body: 'draft one', reason: 'r' }));

    // Unknown prior candidate fails closed.
    const unknown = await tool.execute('t', {
      action: 'revise',
      revises_candidate_id: 'cand-does-not-exist',
      body: 'edited',
      reason: 'r',
    });
    expect(unknown.details.isError).toBe(true);
    expect(resultText(unknown)).toContain('no prior publication candidate');

    const revise = parseResult(await tool.execute('t', {
      action: 'revise',
      revises_candidate_id: submit.candidateId as string,
      body: 'draft two, edited for the concern',
      reason: 'addressed the concern',
    }));
    expect(revise.candidateId).toBe('cand-2');
    expect(revise.supersedes).toBe('cand-1');
    expect(revise.contentHash).not.toBe(submit.contentHash);
  });

  it('the full loop: a resubmitted edit mints a fresh approval binding and the prior approval is invalidated for the edited content', async () => {
    const tool = makeTool();
    const content1: ShareContent = { body: 'draft one', mediaRefs: [] };
    const content2: ShareContent = { body: 'draft two after the concern', mediaRefs: [] };
    const at = new Date(NOW).toISOString();

    // Draft -> approve -> capsule 1 bound to content1.
    const submit = parseResult(await tool.execute('t', { action: 'submit', body: content1.body, reason: 'r' }));
    await queue.resolve(
      { id: submit.approvalEntryId as string, decision: 'approve' },
      { kind: 'operator', id: 'pierre' },
    );
    expect(store.getCapsuleState('cap-1')?.capsule.content).toEqual(content1);

    // Concern raised -> companion edits herself -> resubmit -> approve -> capsule 2 (content2).
    const revise = parseResult(await tool.execute('t', {
      action: 'revise',
      revises_candidate_id: submit.candidateId as string,
      body: content2.body,
      reason: 'addressed',
    }));
    await queue.resolve(
      { id: revise.approvalEntryId as string, decision: 'approve' },
      { kind: 'operator', id: 'pierre' },
    );
    expect(store.getCapsuleState('cap-2')?.capsule.content).toEqual(content2);

    // Prior approval invalidated FOR THE EDIT: cap-1 can never replay content2.
    const wrong = custody.authorizeReplay({
      capsuleId: 'cap-1',
      content: content2,
      destination: PUBLICATION_DESTINATION,
      now: at,
      currentEffectiveSensitivity: 'intimate',
    });
    expect(wrong).toMatchObject({ authorized: false, code: 'content_hash_mismatch' });

    // The fresh binding authorizes the edited content.
    const right = custody.authorizeReplay({
      capsuleId: 'cap-2',
      content: content2,
      destination: PUBLICATION_DESTINATION,
      now: at,
      currentEffectiveSensitivity: 'intimate',
    });
    expect(right).toMatchObject({ authorized: true });
  });

  it('never mints, approves, or revokes a capsule from the tool itself', async () => {
    const tool = makeTool();
    // A bare submit only enqueues; it must not mint.
    await tool.execute('t', { action: 'submit', body: 'b', reason: 'r' });
    expect(store.list()).toHaveLength(0);
    // The tool exposes no approve/revoke verb.
    const bogus = await tool.execute('t', { action: 'approve' as never });
    expect(bogus.details.isError).toBe(true);
    expect(resultText(bogus)).toContain('action must be one of');
  });

  // ── Fail-closed on absent runtime dependencies ─────────────────────────────

  it('fails closed with a clear error when the custody service is unwired', async () => {
    const tool = makeTool({ getCustody: () => null });
    const result = await tool.execute('t', { action: 'submit', body: 'b', reason: 'r' });
    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('publication custody is unavailable');
  });

  it('fails closed on status when the approval queue is unwired', async () => {
    const tool = makeTool({ getApprovalQueue: () => null });
    const result = await tool.execute('t', { action: 'status' });
    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('approval queue is unavailable');
  });

  it('fails closed when no attestable disclosure lineage is available', async () => {
    const tool = makeTool({ getDisclosureLineage: () => undefined });
    const result = await tool.execute('t', { action: 'submit', body: 'b', reason: 'r' });
    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('no attestable disclosure lineage');
  });

  it('fails closed when the context carries an unclassified / untrusted-derived source', async () => {
    const tool = makeTool({
      getDisclosureLineage: () => ({ ...CLASSIFIED_LINEAGE, hasUnclassifiedSource: true }),
    });
    const result = await tool.execute('t', { action: 'submit', body: 'b', reason: 'r' });
    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('unclassified or untrusted-derived');
  });
});
