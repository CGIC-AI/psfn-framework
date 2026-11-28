// psfn-framework-c5e65: the audited operator principal creates, edits,
// toggles, rolls back and deletes operator-type prompt layers through the
// Garden prompt API, audited and with the existing static-prefix validation;
// the testing-harness door and non-operators stay refused.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptLayerStore } from '../../../core/identity/prompt-store.js';
import { ensureTemporalRulesPromptLayer } from '../../../core/identity/temporal-rules-layer.js';
import { ParticipationAppraiser } from '../../../core/participation/appraiser.js';
import { selectAppraiserOperatorGuidance } from '../../../core/participation/operator-guidance.js';
import type { ParticipationCandidate } from '../../../core/participation/types.js';
import { createDecisionRuntime, type RemoteDecisionBackend } from '../../../primitives/llm/decision/decide.js';
import { createDefaultDecisionBackendSettings } from '../../../system/config/decision-backend-config.js';
import type { GardenRequestContext } from '../garden-request-context.js';
import { AdminPromptsDataService } from './prompts-service.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function harness() {
  tempDir = mkdtempSync(join(tmpdir(), 'garden-operator-layers-'));
  const promptStore = new PromptLayerStore(
    join(tempDir, 'prompt-layers.json'),
    join(tempDir, 'prompt-history.jsonl'),
  );
  promptStore.seedFromCharacterCard('seeded foundation');
  ensureTemporalRulesPromptLayer(promptStore);
  const appendAuditTimelineEntry = vi.fn();
  const service = new AdminPromptsDataService({ promptStore, appendAuditTimelineEntry });
  return { promptStore, service, appendAuditTimelineEntry };
}

function fleetContext(actor: {
  provider: 'discord' | 'admin_token' | 'testing_harness';
  role: 'owner' | 'admin' | 'member';
  sessionAssurance?: 'oauth' | 'break_glass';
  accessMode?: 'sole_admin' | 'multi_admin';
  principalId?: string;
}, action = 'prompts.manage'): GardenRequestContext {
  return {
    kind: 'fleet_principal',
    requestId: 'request-fixture',
    decisionId: 'decision-fixture',
    authorizationEventId: 'event-fixture',
    action,
    actor: {
      kind: 'fleet_principal',
      principalId: actor.principalId ?? `${actor.provider}-principal`,
      provider: actor.provider,
      providerSubjectId: 'subject-fixture',
      contactId: 'contact-fixture',
      contactBindingId: 'binding-fixture',
      role: actor.role,
      operatorGrantId: 'grant-fixture',
      sessionRecordId: 'session-fixture',
      sessionAssurance: actor.sessionAssurance ?? 'oauth',
      accessMode: actor.accessMode ?? 'sole_admin',
    },
  } as unknown as GardenRequestContext;
}

const ADMIN_TOKEN = fleetContext({
  provider: 'admin_token',
  role: 'owner',
  sessionAssurance: 'break_glass',
  principalId: 'admin-token-operator',
});
const SSO_OWNER = fleetContext({ provider: 'discord', role: 'owner' });
const STANDALONE = {
  kind: 'standalone_token',
  actor: { kind: 'standalone_operator', actorId: 'standalone-token:operator' },
} as unknown as GardenRequestContext;

function createBody(identifier = 'operator.shakedown_briefing', content = 'Stay concise.') {
  return JSON.stringify({ type: 'operator', name: 'Shakedown briefing', identifier, content });
}

describe('operator-type prompt layers through the Garden prompt API', () => {
  it.each([
    ['audited ADMIN_TOKEN operator', ADMIN_TOKEN, 'admin-token:admin-token-operator'],
    ['SSO owner with prompts.manage', SSO_OWNER, 'fleet-principal:discord-principal'],
    ['standalone operator', STANDALONE, 'standalone-token:operator'],
  ])('lets the %s create, edit, toggle and delete an operator layer, audited', (_label, context, actor) => {
    const { service, promptStore, appendAuditTimelineEntry } = harness();
    const created = service.createPromptLayer(createBody(), context);
    expect(created).toMatchObject({ ok: true, layer: { type: 'operator', identifier: 'operator.shakedown_briefing' } });
    const layerId = created.layer!.id;
    expect(appendAuditTimelineEntry).toHaveBeenLastCalledWith(
      'identity_edit',
      'allowed',
      expect.stringContaining('created operator prompt layer'),
      expect.arrayContaining([`operatorActor=${actor}`]),
      context,
    );

    expect(service.updatePromptLayer(JSON.stringify({ layerId, content: 'Stay very concise.' }), context))
      .toMatchObject({ ok: true });
    expect(promptStore.getById(layerId)?.content).toBe('Stay very concise.');

    expect(service.togglePromptLayer(JSON.stringify({ layerId }), context)).toMatchObject({ ok: true });
    expect(promptStore.getById(layerId)?.enabled).toBe(false);
    expect(service.rollbackPromptLayer(JSON.stringify({ layerId, version: 1 }), context))
      .toMatchObject({ ok: true });

    expect(service.deletePromptLayer(JSON.stringify({ layerId }), context)).toMatchObject({ ok: true });
    expect(promptStore.getById(layerId)).toBeUndefined();
    expect(appendAuditTimelineEntry).toHaveBeenLastCalledWith(
      'identity_edit',
      'allowed',
      expect.stringContaining('deleted operator prompt layer'),
      expect.arrayContaining([`operatorActor=${actor}`]),
      context,
    );
  });

  it.each([
    ['testing-harness door', fleetContext({ provider: 'testing_harness', role: 'owner' }), /testing-harness/u],
    ['SSO member', fleetContext({ provider: 'discord', role: 'member' }), /operator principal/u],
    ['a non-prompts action', fleetContext({ provider: 'discord', role: 'owner' }, 'memory.read.self'), /prompts\.manage/u],
    ['a public caller', { kind: 'public' } as unknown as GardenRequestContext, /authenticated operator/u],
    ['a caller without request context', undefined, /authenticated operator/u],
  ])('refuses the %s on every operator-layer write', (_label, context, message) => {
    const { service, promptStore } = harness();
    expect(service.createPromptLayer(createBody(), context)).toMatchObject({ ok: false, message: expect.stringMatching(message) });
    const seeded = service.createPromptLayer(createBody('operator.seeded'), ADMIN_TOKEN).layer!;
    for (const result of [
      service.updatePromptLayer(JSON.stringify({ layerId: seeded.id, content: 'hijack' }), context),
      service.togglePromptLayer(JSON.stringify({ layerId: seeded.id }), context),
      service.rollbackPromptLayer(JSON.stringify({ layerId: seeded.id, version: 1 }), context),
      service.deletePromptLayer(JSON.stringify({ layerId: seeded.id }), context),
    ]) {
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(message) });
    }
    expect(promptStore.getById(seeded.id)).toMatchObject({ content: 'Stay concise.', enabled: true });
  });

  it('keeps identifier, scope and static-prefix validation for operator layers', () => {
    const { service, promptStore } = harness();
    expect(service.createPromptLayer(createBody('shakedown_briefing'), ADMIN_TOKEN))
      .toMatchObject({ ok: false, message: expect.stringMatching(/operator\./u) });
    expect(service.createPromptLayer(createBody('operator.temporal_rules'), ADMIN_TOKEN))
      .toMatchObject({ ok: false, message: expect.stringMatching(/reserved/u) });
    expect(service.createPromptLayer(JSON.stringify({
      type: 'operator', name: 'Scoped', identifier: 'operator.scoped', content: 'x', channelType: 'discord',
    }), ADMIN_TOKEN)).toMatchObject({ ok: false, message: expect.stringMatching(/channelType/u) });
    expect(service.createPromptLayer(createBody('operator.volatile', 'It is {{current_datetime}}.'), ADMIN_TOKEN))
      .toMatchObject({ ok: false, message: expect.stringMatching(/turn-volatile/u) });
    expect(service.createPromptLayer(createBody('operator.once'), ADMIN_TOKEN)).toMatchObject({ ok: true });
    expect(service.createPromptLayer(createBody('operator.once'), ADMIN_TOKEN))
      .toMatchObject({ ok: false, message: expect.stringMatching(/already uses/u) });

    const temporal = promptStore.getAll().find(layer => layer.identifier === 'operator.temporal_rules')!;
    expect(service.deletePromptLayer(JSON.stringify({ layerId: temporal.id }), ADMIN_TOKEN))
      .toMatchObject({ ok: false, message: expect.stringMatching(/disable them instead/u) });
    const base = promptStore.getByType('base')[0]!;
    expect(service.deletePromptLayer(JSON.stringify({ layerId: base.id }), ADMIN_TOKEN))
      .toMatchObject({ ok: false, message: expect.stringMatching(/Only operator/u) });
  });

  it('leaves runtime, channel and task layer writes unchanged for non-operator callers', () => {
    const { service } = harness();
    const member = fleetContext({ provider: 'discord', role: 'member' });
    expect(service.createPromptLayer(JSON.stringify({
      type: 'task', name: 'Task note', content: 'task scoped', taskKind: 'research',
    }), member)).toMatchObject({ ok: true, layer: { type: 'task' } });
  });

  it('tells the Garden list which principals may write operator layers (psfn-framework-cavke)', () => {
    const { service } = harness();
    for (const context of [ADMIN_TOKEN, SSO_OWNER, STANDALONE]) {
      expect(service.listPrompts(context).canWriteOperatorLayers).toBe(true);
    }
    for (const context of [
      fleetContext({ provider: 'testing_harness', role: 'owner' }),
      fleetContext({ provider: 'discord', role: 'member' }),
      { kind: 'public' } as unknown as GardenRequestContext,
      undefined,
    ]) {
      expect(service.listPrompts(context).canWriteOperatorLayers).toBe(false);
    }
    // The read route's action does not grant write; the list flag reflects the principal.
    expect(service.listPrompts(fleetContext({ provider: 'discord', role: 'owner' }, 'prompts.read'))
      .canWriteOperatorLayers).toBe(true);
  });
});

// psfn-framework-1oqg1: the operator declares which operator layers a remote
// participation-appraisal backend may see. Undeclared layers fail closed.
describe('operator layer remote-appraisal sharing through the Garden prompt API', () => {
  const candidate: ParticipationCandidate = {
    schemaVersion: 1,
    channelId: 'room-demo',
    channelType: 'discord',
    sourceMessageId: 'msg-demo',
    trigger: 'passive_name',
    triggerAuthorId: 'human-demo',
    triggerAuthorIsMachine: false,
    triggerAuthorName: 'Robin',
    triggerContent: 'curious what the companion makes of this',
    triggerTimestampMs: 2_000_000,
    matchedName: true,
    matchedDirectAddress: false,
    precedingContext: [],
    createdAtMs: 2_000_001,
  };

  function remoteRequestFor(promptStore: ReturnType<typeof harness>['promptStore']) {
    const jev = vi.fn<RemoteDecisionBackend['decide']>(async () => ({
      ok: true,
      answers: { action: { type: 'choice', choice: 'ignore', probabilities: { ignore: 0.9, react: 0.05, reply: 0.05 } } },
      backend: 'jev',
      probabilitySource: 'jev',
      latencyMs: 1,
      model: 'remote-demo',
    }));
    const decisions = createDecisionRuntime({
      local: { decide: vi.fn(async () => { throw new Error('local backend must not run'); }) },
      jev: { decide: jev },
      resolveSettings: () => ({
        ...createDefaultDecisionBackendSettings(),
        sites: { 'participation.appraise': { mode: 'jev' } },
      }),
      shadowSink: { record: () => undefined },
    });
    const appraiser = new ParticipationAppraiser({
      llmProvider: { complete: vi.fn(async () => { throw new Error('local model must not run'); }) },
      companionName: 'Demo Companion',
      decisions,
      // The same selector the speaking-arbiter lane wires to the live store.
      operatorGuidance: () => selectAppraiserOperatorGuidance(promptStore.getByType('operator')),
    });
    return { appraiser, jev };
  }

  it('keeps a new operator layer private until the operator shares it, and can unshare it', async () => {
    const { service, promptStore, appendAuditTimelineEntry } = harness();
    const shared = service.createPromptLayer(createBody('operator.room_policy', 'SHAREABLE-ROOM-POLICY'), ADMIN_TOKEN).layer!;
    service.createPromptLayer(createBody('operator.private_notes', 'PRIVATE-OPERATOR-NOTES'), ADMIN_TOKEN);

    const before = remoteRequestFor(promptStore);
    await before.appraiser.appraise(candidate);
    expect(JSON.stringify(before.jev.mock.calls[0]?.[0])).not.toContain('SHAREABLE-ROOM-POLICY');
    expect(JSON.stringify(before.jev.mock.calls[0]?.[0])).not.toContain('PRIVATE-OPERATOR-NOTES');

    expect(service.updatePromptLayer(
      JSON.stringify({ layerId: shared.id, remoteAppraisalShareable: true }),
      ADMIN_TOKEN,
    )).toMatchObject({ ok: true, layer: { remoteAppraisalShareable: true } });
    expect(appendAuditTimelineEntry).toHaveBeenLastCalledWith(
      'identity_edit',
      'allowed',
      expect.any(String),
      expect.arrayContaining(['remoteAppraisalShareable=true']),
      ADMIN_TOKEN,
    );

    const after = remoteRequestFor(promptStore);
    await after.appraiser.appraise(candidate);
    const request = JSON.stringify(after.jev.mock.calls[0]?.[0]);
    expect(request).toContain('SHAREABLE-ROOM-POLICY');
    expect(request).not.toContain('PRIVATE-OPERATOR-NOTES');

    expect(service.updatePromptLayer(
      JSON.stringify({ layerId: shared.id, remoteAppraisalShareable: false }),
      ADMIN_TOKEN,
    )).toMatchObject({ ok: true });
    const unshared = remoteRequestFor(promptStore);
    await unshared.appraiser.appraise(candidate);
    expect(JSON.stringify(unshared.jev.mock.calls[0]?.[0])).not.toContain('SHAREABLE-ROOM-POLICY');
  });

  it('refuses the declaration from non-operator writers, on non-operator layers, and when malformed', () => {
    const { service, promptStore } = harness();
    const layer = service.createPromptLayer(createBody('operator.room_policy'), ADMIN_TOKEN).layer!;
    const sharing = JSON.stringify({ layerId: layer.id, remoteAppraisalShareable: true });
    expect(service.updatePromptLayer(sharing, fleetContext({ provider: 'testing_harness', role: 'owner' })))
      .toMatchObject({ ok: false, message: expect.stringMatching(/testing-harness/u) });
    expect(service.updatePromptLayer(sharing, fleetContext({ provider: 'discord', role: 'member' })))
      .toMatchObject({ ok: false });
    expect(service.updatePromptLayer(
      JSON.stringify({ layerId: layer.id, remoteAppraisalShareable: 'yes' }),
      ADMIN_TOKEN,
    )).toMatchObject({ ok: false, message: expect.stringMatching(/must be a boolean/u) });
    expect(promptStore.getById(layer.id)?.remoteAppraisalShareable).toBeUndefined();

    const base = promptStore.getByType('base')[0]!;
    expect(service.updatePromptLayer(
      JSON.stringify({ layerId: base.id, remoteAppraisalShareable: true }),
      ADMIN_TOKEN,
    )).toMatchObject({ ok: false, message: expect.stringMatching(/only to operator/u) });
    expect(promptStore.getById(base.id)?.remoteAppraisalShareable).toBeUndefined();
  });
});
