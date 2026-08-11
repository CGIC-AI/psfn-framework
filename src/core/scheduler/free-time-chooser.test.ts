import { describe, expect, it, vi } from 'vitest';
import type { ContextEnvelope } from '../../system/trust/context-envelope.js';
import type { LLMContext, LLMResponse } from '../../shared/contracts/runtime.js';
import type { CompletionPurpose } from '../../shared/contracts/runtime.js';
import type { LLMProviderCompletionOptions } from '../agent/contracts.js';
import { createDefaultFreeTimeChooserSettings } from '../../system/config/free-time-chooser-config.js';
import {
  FreeTimeWorkspaceResolver,
  resolveFreeTimeWorkspace,
  type FreeTimeProjectRecord,
  type ResolvedRoomChannel,
} from './free-time-workspace-resolver.js';
import {
  FreeTimeChooser,
  createFreeTimeRoomChannelResolver,
  parseFreeTimeChoiceOptionId,
  type FreeTimeChooserPorts,
  type FreeTimeProjectSummary,
} from './free-time-chooser.js';
import { InMemoryRestWindowPolicy } from './rest-window-policy.js';

// ── Fixtures ──

const INVITE_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'invite_only',
  audienceScope: 'group',
  audienceKnowledge: 'all_known',
  broadcast: false,
};

const PUBLIC_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'public',
  audienceScope: 'group',
  audienceKnowledge: 'anonymous',
  broadcast: false,
};

const BROADCAST_ENVELOPE: ContextEnvelope = {
  channelPrivacy: 'public',
  audienceScope: 'group',
  audienceKnowledge: 'anonymous',
  broadcast: true,
};

function llmResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: 'test-model',
    inputTokens: 0,
    outputTokens: 0,
    stopReason: 'stop',
  };
}

type CompleteFn = (
  context: LLMContext,
  purpose: CompletionPurpose,
  options?: LLMProviderCompletionOptions,
) => Promise<LLMResponse>;

function providerReturning(...scriptedContents: string[]): { complete: ReturnType<typeof vi.fn> } {
  let call = 0;
  const complete = vi.fn<Parameters<CompleteFn>, ReturnType<CompleteFn>>(async () => {
    const content = scriptedContents[Math.min(call, scriptedContents.length - 1)];
    call += 1;
    return llmResponse(content);
  });
  return { complete };
}

const MOON_PROJECT: Record<string, FreeTimeProjectRecord> = {
  'project:moon': { projectRef: 'project:moon', workspace: { kind: 'private' } },
};

function makeChooser(overrides: Partial<FreeTimeChooserPorts> = {}): {
  chooser: FreeTimeChooser;
  restWindowPolicy: InMemoryRestWindowPolicy;
  resolver: FreeTimeWorkspaceResolver;
  provider: { complete: ReturnType<typeof vi.fn> };
} {
  const provider = (overrides.llmProvider ?? providerReturning('{"optionId":"private_wander"}')) as {
    complete: ReturnType<typeof vi.fn>;
  };
  const restWindowPolicy = (overrides.restWindowPolicy ?? new InMemoryRestWindowPolicy()) as InMemoryRestWindowPolicy;
  const resolver = overrides.resolver ?? new FreeTimeWorkspaceResolver({
    projectDirectory: (ref: string) => MOON_PROJECT[ref] ?? null,
    roomChannelResolver: () => null,
  });
  const listResumableProjects = overrides.listResumableProjects ?? ((): FreeTimeProjectSummary[] => [
    { projectRef: 'project:moon', title: 'Moon Garden', workContextLabel: 'private', focusHint: 'revise scene two' },
  ]);
  const chooser = new FreeTimeChooser({
    llmProvider: provider,
    resolver,
    restWindowPolicy,
    listResumableProjects,
    companionName: 'Companion',
    ...(overrides.offerNewWorkspace ? { offerNewWorkspace: overrides.offerNewWorkspace } : {}),
    ...(overrides.settings ? { settings: overrides.settings } : {}),
    ...(overrides.companionId ? { companionId: overrides.companionId } : {}),
  });
  return { chooser, restWindowPolicy, resolver, provider };
}

const CTX = { lane: 'quiet_hours' as const, nowMs: 1_000 };

// ── listChoices ──

describe('FreeTimeChooser.listChoices', () => {
  it('always offers private wandering and one resume option per project', () => {
    const { chooser } = makeChooser();
    const set = chooser.listChoices(CTX);
    expect(set.restOptionId).toBe('rest');
    expect(set.workOptions.map(o => o.optionId)).toEqual(['private_wander', 'resume:project:moon']);
  });

  it('offers a create option only when offerNewWorkspace yields one', () => {
    const withCreate = makeChooser({
      offerNewWorkspace: () => ({
        kind: 'create_workspace',
        projectRef: 'project:new',
        workspace: { kind: 'private' },
      }),
    });
    expect(withCreate.chooser.listChoices(CTX).workOptions.map(o => o.optionId))
      .toContain('create');

    const noCreate = makeChooser({ offerNewWorkspace: () => null });
    expect(noCreate.chooser.listChoices(CTX).workOptions.map(o => o.optionId))
      .not.toContain('create');
  });
});

// ── choice mapping (resolver integration through the ports) ──

describe('FreeTimeChooser.chooseWorkspace — choice mapping', () => {
  it('maps private_wander to the private continuity session', async () => {
    const { chooser, provider } = makeChooser({ llmProvider: providerReturning('{"optionId":"private_wander"}') });
    const outcome = await chooser.chooseWorkspace(CTX);
    expect(outcome.kind).toBe('workspace');
    if (outcome.kind !== 'workspace') throw new Error('expected workspace');
    expect(outcome.choice).toEqual({ kind: 'private_wander' });
    expect(outcome.workspace.sessionId).toBe('internal:free-time:private');
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('maps a resume option to the resolved project workspace', async () => {
    const { chooser } = makeChooser({ llmProvider: providerReturning('{"optionId":"resume:project:moon"}') });
    const outcome = await chooser.chooseWorkspace(CTX);
    expect(outcome.kind).toBe('workspace');
    if (outcome.kind !== 'workspace') throw new Error('expected workspace');
    expect(outcome.choice).toEqual({ kind: 'resume_project', projectRef: 'project:moon' });
    expect(outcome.workspace.sessionId).toBe('internal:free-time:project:moon');
  });

  it('maps a create option through the resolver', async () => {
    const { chooser } = makeChooser({
      llmProvider: providerReturning('{"optionId":"create"}'),
      offerNewWorkspace: () => ({
        kind: 'create_workspace',
        projectRef: 'project:fresh',
        workspace: { kind: 'private' },
      }),
    });
    const outcome = await chooser.chooseWorkspace(CTX);
    expect(outcome.kind).toBe('workspace');
    if (outcome.kind !== 'workspace') throw new Error('expected workspace');
    expect(outcome.workspace.sessionId).toBe('internal:free-time:project:fresh');
  });
});

// ── rest + silence persistence (the acceptance criterion) ──

describe('FreeTimeChooser.chooseWorkspace — rest and silence persistence', () => {
  it('rest ends without a second model call and records silence', async () => {
    const { chooser, provider, resolver } = makeChooser({
      llmProvider: providerReturning('{"optionId":"rest","reason":"tired"}'),
    });
    const resolveSpy = vi.spyOn(resolver, 'resolve');

    const outcome = await chooser.chooseWorkspace(CTX);

    expect(outcome).toEqual({ kind: 'rest', reason: 'companion_rested' });
    // The chooser call is the ONLY model call; rest triggers no second call.
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('does not re-prompt within the quiet period after a rest, then re-prompts once it expires', async () => {
    const settings = { ...createDefaultFreeTimeChooserSettings(), silencePersistenceMinutes: 10 };
    const { chooser, provider } = makeChooser({
      llmProvider: providerReturning('{"optionId":"rest"}'),
      settings,
    });

    const first = await chooser.chooseWorkspace({ lane: 'quiet_hours', nowMs: 0 });
    expect(first.kind).toBe('rest');
    expect(provider.complete).toHaveBeenCalledTimes(1);

    // A re-check inside the 10-minute window is suppressed with NO model call.
    const suppressed = await chooser.chooseWorkspace({ lane: 'quiet_hours', nowMs: 5 * 60_000 });
    expect(suppressed).toEqual({ kind: 'suppressed', reason: 'rest_silenced' });
    expect(provider.complete).toHaveBeenCalledTimes(1);

    // A different lane is not suppressed by the quiet-hours rest.
    const idle = await chooser.chooseWorkspace({ lane: 'idle', nowMs: 5 * 60_000 });
    expect(idle.kind).not.toBe('suppressed');
    expect(provider.complete).toHaveBeenCalledTimes(2);

    // Once the window expires the quiet-hours lane prompts again.
    const afterExpiry = await chooser.chooseWorkspace({ lane: 'quiet_hours', nowMs: 11 * 60_000 });
    expect(afterExpiry.kind).not.toBe('suppressed');
    expect(provider.complete).toHaveBeenCalledTimes(3);
  });
});

// ── fail-closed posture ──

describe('FreeTimeChooser.chooseWorkspace — fail closed to rest', () => {
  it('falls closed to rest and records silence when the provider throws', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('provider down'));
    const { chooser, restWindowPolicy } = makeChooser({ llmProvider: { complete } });
    const outcome = await chooser.chooseWorkspace(CTX);
    expect(outcome).toEqual({ kind: 'rest', reason: 'chooser_error' });
    expect(restWindowPolicy.isSilenced({ lane: 'quiet_hours', nowMs: 2_000 })).toBe(true);
  });

  it('falls closed to rest on a chooser timeout', async () => {
    const complete = vi.fn(() => new Promise<LLMResponse>(() => {
      /* never resolves — force the deadline to win */
    }));
    const settings = { ...createDefaultFreeTimeChooserSettings(), chooserDeadlineMs: 10 };
    const { chooser } = makeChooser({ llmProvider: { complete }, settings });
    const outcome = await chooser.chooseWorkspace(CTX);
    expect(outcome).toEqual({ kind: 'rest', reason: 'chooser_timeout' });
  });

  it('falls closed to rest on unparseable output', async () => {
    const { chooser } = makeChooser({ llmProvider: providerReturning('no json here, just prose') });
    const outcome = await chooser.chooseWorkspace(CTX);
    expect(outcome).toEqual({ kind: 'rest', reason: 'chooser_unparseable' });
  });

  it('falls closed to rest when the model invents an unoffered option', async () => {
    const { chooser } = makeChooser({ llmProvider: providerReturning('{"optionId":"resume:project:ghost"}') });
    const outcome = await chooser.chooseWorkspace(CTX);
    expect(outcome).toEqual({ kind: 'rest', reason: 'chooser_invalid_option' });
  });

  it('falls closed to rest when the resolver rejects a chosen option', async () => {
    // The menu offers a project ref that the directory does not know, so the
    // resolver throws — the chooser must fail closed to rest, never a workspace.
    const resolver = new FreeTimeWorkspaceResolver({
      projectDirectory: () => null,
      roomChannelResolver: () => null,
    });
    const { chooser } = makeChooser({
      resolver,
      llmProvider: providerReturning('{"optionId":"resume:project:moon"}'),
      listResumableProjects: () => [
        { projectRef: 'project:moon', title: 'Moon', workContextLabel: 'private' },
      ],
    });
    const outcome = await chooser.chooseWorkspace(CTX);
    expect(outcome).toEqual({ kind: 'rest', reason: 'resolve_failed' });
  });

  it('rests without a model call or silence when disabled', async () => {
    const settings = { ...createDefaultFreeTimeChooserSettings(), enabled: false };
    const { chooser, provider, restWindowPolicy } = makeChooser({ settings });
    const outcome = await chooser.chooseWorkspace(CTX);
    expect(outcome).toEqual({ kind: 'rest', reason: 'chooser_disabled' });
    expect(provider.complete).not.toHaveBeenCalled();
    expect(restWindowPolicy.isSilenced({ lane: 'quiet_hours', nowMs: 2_000 })).toBe(false);
  });
});

// ── roomChannelResolver factory (documented port obligation + public_room clamp) ──

describe('createFreeTimeRoomChannelResolver', () => {
  it('sources the disclosure ceiling from the injected ceiling function', () => {
    const resolve = createFreeTimeRoomChannelResolver(
      () => INVITE_ENVELOPE,
      () => 'personal',
    );
    expect(resolve('c1')).toEqual({ envelope: INVITE_ENVELOPE, disclosureCeiling: 'personal' });
  });

  it('clamps a public room ceiling to public even if the ceiling fn returns higher', () => {
    const resolve = createFreeTimeRoomChannelResolver(
      () => PUBLIC_ENVELOPE,
      () => 'confidential',
    );
    expect(resolve('c1')?.disclosureCeiling).toBe('public');
  });

  it('clamps a broadcast room ceiling to public', () => {
    const resolve = createFreeTimeRoomChannelResolver(
      () => BROADCAST_ENVELOPE,
      () => 'intimate',
    );
    expect(resolve('c1')?.disclosureCeiling).toBe('public');
  });

  it('returns null for an unresolvable channel (fail closed)', () => {
    const resolve = createFreeTimeRoomChannelResolver(() => null, () => 'public');
    expect(resolve('missing')).toBeNull();
  });
});

// ── resolver belt-and-suspenders public_room retrieval clamp ──

describe('resolveFreeTimeWorkspace — public_room retrieval clamp', () => {
  it('clamps public_room retrieval to public even when the channel ceiling is higher', () => {
    const channel: ResolvedRoomChannel = { envelope: PUBLIC_ENVELOPE, disclosureCeiling: 'confidential' };
    const workspace = resolveFreeTimeWorkspace(
      { kind: 'create_workspace', projectRef: 'project:pub', workspace: { kind: 'room', channelId: 'room-1' } },
      { projectDirectory: () => null, roomChannelResolver: () => channel },
    );
    expect(workspace.retrievalPolicy.disclosureCeiling).toEqual({ kind: 'public_room', channelId: 'room-1' });
    expect(workspace.retrievalPolicy.retrievalCeiling).toBe('public');
  });
});

// ── parser ──

describe('parseFreeTimeChoiceOptionId', () => {
  it('extracts a valid optionId', () => {
    expect(parseFreeTimeChoiceOptionId('{"optionId":"rest","reason":"x"}')).toBe('rest');
  });

  it('extracts an optionId embedded in surrounding prose', () => {
    expect(parseFreeTimeChoiceOptionId('Sure! {"optionId":"private_wander"} done')).toBe('private_wander');
  });

  it('rejects non-JSON, non-string, oversized, and missing ids', () => {
    expect(parseFreeTimeChoiceOptionId('just talking')).toBeNull();
    expect(parseFreeTimeChoiceOptionId('{"optionId":42}')).toBeNull();
    expect(parseFreeTimeChoiceOptionId('{"reason":"x"}')).toBeNull();
    expect(parseFreeTimeChoiceOptionId(`{"optionId":"${'a'.repeat(200)}"}`)).toBeNull();
  });
});
