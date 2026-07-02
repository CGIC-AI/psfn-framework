// ── Context Envelope gating harness (E3.3) ──
// One fixture per envelope class, with documented gate outcomes:
//   dm-private                    → { private,    one,  all_known,        broadcast: false }
//   invite_only-few-all_known     → { invite_only, few,  all_known,       broadcast: false }
//   public-many-partially_known   → { public,     many, partially_known,  broadcast: false }
//   public+broadcast              → { public,     ...,  ...,              broadcast: true  }
//
// Asserts: derivation (including the fail-closed rules), envelope-keyed gate
// outcomes with withheld reasons that cite envelope dimensions, response-style
// independence from privacy (channel-owned deliveryStyle), and that the
// envelope reaches prompts as bare-value macros only — never prose.

import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveScopeContextEnvelope,
  DEFAULT_AUDIENCE_SCOPE_THRESHOLDS,
  type ContextEnvelope,
} from './context-envelope.js';
import {
  buildContextEnvelopePromptState,
  classifyChannelDisclosure,
  classifyChannelEnvelope,
  evaluateMemoryPolicy,
  getAllowedSensitivities,
  getVisibilityDisclosureCeiling,
  resolveChannelResponseStyle,
  visibilitiesShareContinuity,
} from './policy.js';
import { resolveBroadcastVisibilityScope } from './broadcast-safety.js';
import {
  resetRuntimeChannelEnvelopeLabels,
  setRuntimeChannelEnvelopeLabels,
} from './runtime-channel-labels.js';
import { resetRuntimeTrustPolicy } from './runtime-policy.js';
import { resolveConversationScopeFromMetadata } from '../../core/session/conversation-scope.js';

const thresholds = DEFAULT_AUDIENCE_SCOPE_THRESHOLDS;

afterEach(() => {
  resetRuntimeChannelEnvelopeLabels();
  resetRuntimeTrustPolicy();
});

function deriveFixtureEnvelope(input: {
  channelId: string;
  kind: 'dm' | 'group';
  dmContactResolved?: boolean;
  recentSpeakerCount: number;
  resolvedSpeakerContactCount?: number;
  memberCountHint?: number;
}): ContextEnvelope {
  return deriveScopeContextEnvelope({
    classification: classifyChannelDisclosure(input.channelId, input.kind === 'dm' ? { isDirectMessage: true } : undefined),
    kind: input.kind,
    recentSpeakerCount: input.recentSpeakerCount,
    thresholds,
    ...(input.dmContactResolved !== undefined ? { dmContactResolved: input.dmContactResolved } : {}),
    ...(input.resolvedSpeakerContactCount !== undefined
      ? { resolvedSpeakerContactCount: input.resolvedSpeakerContactCount }
      : {}),
    ...(input.memberCountHint !== undefined ? { memberCountHint: input.memberCountHint } : {}),
  });
}

describe('envelope class fixtures: derivation and gate outcomes', () => {
  it('dm-private: one/all_known; intimate stays honne-gated by trust, not channel', () => {
    const envelope = deriveFixtureEnvelope({
      channelId: 'discord:dm:42',
      kind: 'dm',
      dmContactResolved: true,
      recentSpeakerCount: 1,
      resolvedSpeakerContactCount: 1,
    });
    expect(envelope).toEqual({
      channelPrivacy: 'private',
      audienceScope: 'one',
      audienceKnowledge: 'all_known',
      broadcast: false,
    });

    // Gate outcomes: the private row allows every sensitivity; trust still caps.
    expect(getVisibilityDisclosureCeiling(envelope)).toBe('confidential');
    expect(getAllowedSensitivities('primary', envelope))
      .toEqual(['public', 'personal', 'intimate', 'confidential']);
    expect(getAllowedSensitivities('public', envelope)).toEqual(['public']);

    expect(evaluateMemoryPolicy({
      trustLevel: 'primary',
      channelPrivacy: envelope.channelPrivacy,
      broadcast: envelope.broadcast,
      memorySensitivity: 'intimate',
    })).toMatchObject({ decision: 'allow', reasonTag: 'default.within_bounds' });

    const trustDenied = evaluateMemoryPolicy({
      trustLevel: 'regular',
      channelPrivacy: envelope.channelPrivacy,
      broadcast: envelope.broadcast,
      memorySensitivity: 'intimate',
    });
    expect(trustDenied).toMatchObject({ decision: 'deny', reasonTag: 'trust.ceiling_exceeded' });
  });

  it('invite_only-few-all_known: bounded known room allows personal, withholds intimate citing channelPrivacy', () => {
    const envelope = deriveFixtureEnvelope({
      channelId: 'discord:friends-room',
      kind: 'group',
      recentSpeakerCount: 4,
      resolvedSpeakerContactCount: 4,
    });
    expect(envelope).toEqual({
      channelPrivacy: 'invite_only',
      audienceScope: 'few',
      audienceKnowledge: 'all_known',
      broadcast: false,
    });

    expect(getAllowedSensitivities('trusted', envelope)).toEqual(['public', 'personal']);

    const denied = evaluateMemoryPolicy({
      trustLevel: 'primary',
      channelPrivacy: envelope.channelPrivacy,
      broadcast: envelope.broadcast,
      memorySensitivity: 'intimate',
    });
    expect(denied.decision).toBe('deny');
    expect(denied.reasonTag).toBe('visibility.channel_restricted');
    // Withheld reason cites the envelope dimension that gated.
    expect(denied.reason).toContain("channelPrivacy 'invite_only'");
  });

  it('public-many-partially_known: roster hint drives many; personal withheld citing channelPrivacy', () => {
    const envelope = deriveFixtureEnvelope({
      channelId: 'discord:town-square',
      kind: 'group',
      recentSpeakerCount: 5,
      resolvedSpeakerContactCount: 2,
      memberCountHint: 50,
    });
    // No label/override: derived default is invite_only, so pin a public
    // label the way channels.json would.
    setRuntimeChannelEnvelopeLabels({ 'discord:town-square': { privacy: 'public' } });
    const labeled = deriveScopeContextEnvelope({
      classification: classifyChannelDisclosure('discord:town-square'),
      kind: 'group',
      recentSpeakerCount: 5,
      resolvedSpeakerContactCount: 2,
      memberCountHint: 50,
      thresholds,
    });
    expect(envelope.audienceScope).toBe('many');
    expect(envelope.audienceKnowledge).toBe('partially_known');
    expect(labeled).toEqual({
      channelPrivacy: 'public',
      audienceScope: 'many',
      audienceKnowledge: 'partially_known',
      broadcast: false,
    });

    expect(getAllowedSensitivities('trusted', labeled)).toEqual(['public']);
    const denied = evaluateMemoryPolicy({
      trustLevel: 'trusted',
      channelPrivacy: labeled.channelPrivacy,
      broadcast: labeled.broadcast,
      memorySensitivity: 'personal',
    });
    expect(denied).toMatchObject({
      decision: 'deny',
      reasonTag: 'visibility.channel_restricted',
      layer: 'visibility',
    });
    expect(denied.reason).toContain("channelPrivacy 'public'");
  });

  it('public+broadcast: broadcast label yields public-only ceiling; denial cites the broadcast dimension', () => {
    setRuntimeChannelEnvelopeLabels({ 'social:megaphone': { broadcast: true } });
    const classification = classifyChannelEnvelope('social:megaphone');
    expect(classification.privacy).toBe('public');
    expect(classification.broadcast).toBe(true);

    const envelope = deriveScopeContextEnvelope({
      classification: { channelPrivacy: classification.privacy, broadcast: classification.broadcast },
      kind: 'group',
      recentSpeakerCount: 0,
      thresholds,
    });
    expect(envelope).toEqual({
      channelPrivacy: 'public',
      audienceScope: 'few',
      audienceKnowledge: 'anonymous',
      broadcast: true,
    });

    // Broadcast ceiling IS the public row (the retired broadcast row folded in).
    expect(getVisibilityDisclosureCeiling(envelope)).toBe(
      getVisibilityDisclosureCeiling({ channelPrivacy: 'public', broadcast: false }),
    );

    const denied = evaluateMemoryPolicy({
      trustLevel: 'primary',
      channelPrivacy: envelope.channelPrivacy,
      broadcast: envelope.broadcast,
      memorySensitivity: 'personal',
    });
    expect(denied).toMatchObject({
      decision: 'deny',
      reasonTag: 'visibility.broadcast_restricted',
      layer: 'visibility',
    });
    expect(denied.reason).toContain('broadcast');

    // Approval-token machinery survives the split: an approved broadcast
    // context elevates via operator approval at layer 1.
    expect(resolveBroadcastVisibilityScope('social:megaphone', {
      broadcastApprovalToken: 'approve:operator-12345678',
    })).toBe('approved_private_context');
    expect(evaluateMemoryPolicy({
      trustLevel: 'primary',
      channelPrivacy: envelope.channelPrivacy,
      broadcast: envelope.broadcast,
      memorySensitivity: 'personal',
      operatorApproval: true,
    })).toMatchObject({ decision: 'allow', reasonTag: 'operator.approval_override' });
  });
});

describe('derivation fail-closed rules', () => {
  it('group with an empty or unknown speaker window is anonymous, never all_known', () => {
    expect(deriveFixtureEnvelope({
      channelId: 'discord:quiet-room',
      kind: 'group',
      recentSpeakerCount: 0,
    }).audienceKnowledge).toBe('anonymous');
    expect(deriveFixtureEnvelope({
      channelId: 'discord:quiet-room',
      kind: 'group',
      recentSpeakerCount: 3,
      // resolvedSpeakerContactCount absent → fails closed to 0 resolved
    }).audienceKnowledge).toBe('anonymous');
  });

  it('dm with a resolved canonical contact is all_known even on an empty window; unresolved dm is not', () => {
    expect(deriveFixtureEnvelope({
      channelId: 'discord:dm:42',
      kind: 'dm',
      dmContactResolved: true,
      recentSpeakerCount: 0,
    }).audienceKnowledge).toBe('all_known');
    expect(deriveFixtureEnvelope({
      channelId: 'discord:dm:42',
      kind: 'dm',
      dmContactResolved: false,
      recentSpeakerCount: 0,
    }).audienceKnowledge).toBe('anonymous');
  });

  it('audienceScope thresholds: few/many/unbounded over the interim roster bound', () => {
    const scopeFor = (memberCountHint: number) => deriveFixtureEnvelope({
      channelId: 'discord:room',
      kind: 'group',
      recentSpeakerCount: 5,
      memberCountHint,
    }).audienceScope;
    expect(scopeFor(10)).toBe('few');
    expect(scopeFor(11)).toBe('many');
    expect(scopeFor(100)).toBe('many');
    expect(scopeFor(101)).toBe('unbounded');
  });
});

describe('scope attachment', () => {
  it('resolveConversationScopeFromMetadata attaches the derived envelope', () => {
    const scope = resolveConversationScopeFromMetadata({
      channelId: 'discord:friends-room',
      isDirectMessage: false,
      recentSpeakers: [
        { authorId: 'discord:1', name: 'Alice' },
        { authorId: 'discord:2', name: 'Bob' },
      ],
      resolvedSpeakerContactCount: 1,
    });
    expect(scope.kind).toBe('group');
    expect(scope.envelope).toEqual({
      channelPrivacy: 'invite_only',
      audienceScope: 'few',
      audienceKnowledge: 'partially_known',
      broadcast: false,
    });
  });

  it('a dm scope with a caller-supplied contact derives all_known; degraded identity fails closed', () => {
    const genuine = resolveConversationScopeFromMetadata({
      channelId: 'discord:dm:42',
      isDirectMessage: true,
      contact: { contactId: 'contact-alice' },
    });
    expect(genuine.envelope.audienceKnowledge).toBe('all_known');

    const degraded = resolveConversationScopeFromMetadata({
      channelId: 'discord:dm:42',
      isDirectMessage: true,
      participantId: 'discord:42',
    });
    expect(degraded.envelope.audienceKnowledge).toBe('anonymous');
  });
});

describe('continuity direction over the envelope pair', () => {
  it('preserves the documented directional table (broadcast inherits the public row)', () => {
    const p = (channelPrivacy: 'private' | 'invite_only' | 'public', broadcast = false) => (
      { channelPrivacy, broadcast }
    );
    // From private: only into private.
    expect(visibilitiesShareContinuity(p('private'), p('private'))).toBe(true);
    expect(visibilitiesShareContinuity(p('private'), p('invite_only'))).toBe(false);
    expect(visibilitiesShareContinuity(p('private'), p('public'))).toBe(false);
    expect(visibilitiesShareContinuity(p('private'), p('public', true))).toBe(false);
    // From invite_only: private and invite_only.
    expect(visibilitiesShareContinuity(p('invite_only'), p('private'))).toBe(true);
    expect(visibilitiesShareContinuity(p('invite_only'), p('invite_only'))).toBe(true);
    expect(visibilitiesShareContinuity(p('invite_only'), p('public', true))).toBe(false);
    // From public / public+broadcast: everywhere.
    expect(visibilitiesShareContinuity(p('public'), p('public', true))).toBe(true);
    expect(visibilitiesShareContinuity(p('public', true), p('invite_only'))).toBe(true);
    expect(visibilitiesShareContinuity(p('public', true), p('private'))).toBe(true);
  });
});

describe('response style is decoupled from privacy (AC2)', () => {
  it('a public channel with an expressive deliveryStyle label resolves expressive', () => {
    setRuntimeChannelEnvelopeLabels({
      'discord:town-square': { privacy: 'public', deliveryStyle: 'expressive' },
    });
    expect(resolveChannelResponseStyle('discord:town-square')).toBe('expressive');
    expect(classifyChannelEnvelope('discord:town-square')).toMatchObject({
      privacy: 'public',
      deliveryStyle: 'expressive',
      deliveryStyleSource: 'channel_label',
    });
  });

  it('unlabeled channels keep the derived default (private → expressive, else concise)', () => {
    expect(classifyChannelEnvelope('discord:dm', { isDirectMessage: true })).toMatchObject({
      privacy: 'private',
      deliveryStyle: 'expressive',
      deliveryStyleSource: 'derived_default',
    });
    expect(classifyChannelEnvelope('discord:room')).toMatchObject({
      privacy: 'invite_only',
      deliveryStyle: 'concise',
      deliveryStyleSource: 'derived_default',
    });
    // Broadcast surfaces are public → concise (identical to pre-split behavior).
    expect(classifyChannelEnvelope('twitter:main')).toMatchObject({
      privacy: 'public',
      broadcast: true,
      deliveryStyle: 'concise',
    });
  });

  it('a concise label on a private channel overrides the expressive derived default', () => {
    setRuntimeChannelEnvelopeLabels({
      'discord:dm-terse': { privacy: 'private', deliveryStyle: 'concise' },
    });
    expect(resolveChannelResponseStyle('discord:dm-terse', {
      meta: { isDirectMessage: true },
    })).toBe('concise');
  });
});

describe('envelope macros are bare values, never prose (AC3)', () => {
  it('buildContextEnvelopePromptState emits exactly the four bare-value macros', () => {
    const state = buildContextEnvelopePromptState({
      channelPrivacy: 'invite_only',
      audienceScope: 'few',
      audienceKnowledge: 'all_known',
      broadcast: false,
    });
    expect(state).toEqual({
      runtime_channel_privacy: 'invite_only',
      runtime_audience_scope: 'few',
      runtime_audience_knowledge: 'all_known',
      runtime_broadcast: 'false',
    });
    // Bare values only: no whitespace, no sentences, no privacy reasoning.
    for (const value of Object.values(state)) {
      expect(value).toMatch(/^[a-z_]+$/);
    }
  });
});
