import { describe, expect, it } from 'vitest';
import type { PromptCacheScope } from '../../shared/contracts/runtime.js';
import {
  buildPromptCacheObservability,
  resolvePromptCacheAffinity,
  type PromptCacheCorrelation,
} from './client-prompt-cache.js';
import {
  buildSystemPromptCacheBoundaries,
  verifySystemPromptCacheBoundaries,
} from './prompt-cache.js';

// ── Cache-scope privacy invariant (psfn-framework-mmo9.7.6) ──
// Provider prompt caching engages two distinct scope mechanisms:
//   1. an explicit provider affinity/cache token (OpenAI prompt_cache_key,
//      Mistral x-affinity, pi-ai sessionId) derived by resolvePromptCacheAffinity
//   2. content-hash prefix caching (Anthropic cache_control), where the cache
//      entry is keyed by the literal bytes of the cacheable system-prompt prefix
// Both are proven here to be STRUCTURALLY incapable of sharing a cache entry
// across companion or contact boundaries — the property is enforced by the
// derivation, not by policy. A cross-boundary hit would be the exact failure a
// multi-companion fleet sharing one provider credential must never allow.

function affinityToken(
  correlation: PromptCacheCorrelation,
  scope: PromptCacheScope = 'channel',
): string {
  const resolved = resolvePromptCacheAffinity(scope, correlation);
  if (!('sessionId' in resolved)) {
    throw new Error(`expected an affinity token but got failure: ${JSON.stringify(resolved)}`);
  }
  return resolved.sessionId;
}

describe('prompt cache affinity — cross-companion isolation (fleet threat model)', () => {
  it('never shares a token across companions on a byte-identical shared channel', () => {
    // The concrete threat: several fleet companions live in the SAME Discord
    // guild channel and share one provider organisation. The channel id is
    // identical; only the companion differs.
    const sharedChannel = 'discord:guild-42:general';
    const tokens = ['companion-companion', 'companion-artemis', 'companion-lyra'].map(
      companionId => affinityToken({ companionId, channelId: sharedChannel }),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('never shares a token across contacts within one companion on a shared room channel', () => {
    // A group room: one companion, one channel id, several speakers. The
    // canonical subject contact is the only discriminator.
    const companionId = 'companion-companion';
    const roomChannel = 'discord:guild-42:townsquare';
    const tokens = ['contact-alice', 'contact-bob', 'contact-carol'].map(contact =>
      affinityToken({
        companionId,
        channelId: roomChannel,
        viewerMemorySubjectContactId: contact,
      }),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('exhaustively: every distinct (companion, contact, channel) tuple maps to a distinct token', () => {
    const companions = ['companion-a', 'companion-b', 'companion-c'];
    const contacts = ['', 'contact-1', 'contact-2'];
    const channels = ['discord:x', 'discord:y'];
    const tokens: string[] = [];
    for (const companionId of companions) {
      for (const contact of contacts) {
        for (const channelId of channels) {
          tokens.push(
            affinityToken({
              companionId,
              channelId,
              ...(contact ? { viewerMemorySubjectContactId: contact } : {}),
            }),
          );
        }
      }
    }
    // No collisions across the entire cartesian product.
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens.length).toBe(companions.length * contacts.length * channels.length);
  });

  it('does not let a companion id boundary be crossed by colliding inner ids', () => {
    // Even an adversarially chosen channel id for companion B cannot reproduce
    // companion A's token, because companionId is length-prefixed and bound
    // ahead of the inner scope: the label/length framing is injective.
    const a = affinityToken({ companionId: 'ab', channelId: 'c:d' });
    // Attempt to "smuggle" companion A's material into companion B's channel.
    const b = affinityToken({ companionId: 'a', channelId: 'b\u0000c:d' });
    const c = affinityToken({ companionId: 'a', channelId: 'bc:d' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});

describe('prompt cache affinity — within-scope stability (caching actually works)', () => {
  it('is deterministic and stable for an identical (companion, contact, channel) tuple', () => {
    const correlation: PromptCacheCorrelation = {
      companionId: 'companion-companion',
      channelId: 'discord:dm:alice',
      viewerMemorySubjectContactId: 'contact-alice',
    };
    const first = affinityToken(correlation);
    const second = affinityToken({ ...correlation });
    expect(second).toBe(first);
  });

  it('binds the request scope to the request id, independent of the channel', () => {
    const base = { companionId: 'companion-a', channelId: 'discord:shared' };
    const req1 = affinityToken({ ...base, requestId: 'req-1' }, 'request');
    const req2 = affinityToken({ ...base, requestId: 'req-2' }, 'request');
    expect(req1).not.toBe(req2);
    // Channel and request scope for the same companion never collide either.
    const channelScoped = affinityToken(base, 'channel');
    expect(channelScoped).not.toBe(req1);
    expect(channelScoped).not.toBe(req2);
  });

  it('never emits a token containing the raw identifiers it was derived from', () => {
    const token = affinityToken({
      companionId: 'companion-secret',
      channelId: 'discord:dm:private-contact',
      viewerMemorySubjectContactId: 'contact-private',
    });
    expect(token.startsWith('psfnpc-')).toBe(true);
    expect(token).not.toContain('companion-secret');
    expect(token).not.toContain('private-contact');
    expect(token).not.toContain('contact-private');
  });
});

describe('prompt cache affinity — fail closed on an underspecified scope', () => {
  it('fails closed with no companion id (channel scope)', () => {
    expect(resolvePromptCacheAffinity('channel', { channelId: 'discord:x' }))
      .toEqual({ failure: 'missing_companion_id' });
  });

  it('fails closed with no companion id (request scope)', () => {
    expect(resolvePromptCacheAffinity('request', { requestId: 'req-1' }))
      .toEqual({ failure: 'missing_companion_id' });
  });

  it('fails closed with a companion id but no inner scope id', () => {
    expect(resolvePromptCacheAffinity('channel', { companionId: 'companion-a' }))
      .toEqual({ failure: 'missing_channel_id' });
    expect(resolvePromptCacheAffinity('request', { companionId: 'companion-a' }))
      .toEqual({ failure: 'missing_channel_id' });
  });

  it('treats whitespace-only scope fields as absent (fail closed)', () => {
    expect(resolvePromptCacheAffinity('channel', { companionId: '   ', channelId: 'discord:x' }))
      .toEqual({ failure: 'missing_companion_id' });
    expect(resolvePromptCacheAffinity('channel', { companionId: 'companion-a', channelId: '  ' }))
      .toEqual({ failure: 'missing_channel_id' });
  });
});

describe('buildPromptCacheObservability — precise fail-closed reasons', () => {
  const strategyInput = {
    promptCacheStrategy: 'openai_responses' as const,
    promptCacheRetention: 'short' as const,
    promptCacheScope: 'channel' as const,
  };

  it('reports missing_companion_id when the companion scope is absent', () => {
    const observability = buildPromptCacheObservability({
      ...strategyInput,
      correlation: { channelId: 'discord:x' },
    });
    expect(observability).toMatchObject({
      configured: true,
      engaged: false,
      reason: 'missing_companion_id',
    });
    expect(observability.sessionId).toBeUndefined();
  });

  it('reports missing_channel_id when the companion is present but the channel is not', () => {
    const observability = buildPromptCacheObservability({
      ...strategyInput,
      correlation: { companionId: 'companion-a' },
    });
    expect(observability).toMatchObject({
      configured: true,
      engaged: false,
      reason: 'missing_channel_id',
    });
  });

  it('engages with a companion-scoped session id when the scope is fully specified', () => {
    const correlation: PromptCacheCorrelation = {
      companionId: 'companion-a',
      channelId: 'discord:x',
    };
    const observability = buildPromptCacheObservability({ ...strategyInput, correlation });
    expect(observability.engaged).toBe(true);
    expect(observability.sessionId).toBe(affinityToken(correlation));
    // A second companion on the identical channel gets a different session id.
    const other = buildPromptCacheObservability({
      ...strategyInput,
      correlation: { companionId: 'companion-b', channelId: 'discord:x' },
    });
    expect(other.sessionId).not.toBe(observability.sessionId);
  });
});

describe('cacheable content prefix — cross-companion/contact byte isolation', () => {
  // Content-hash caches (Anthropic cache_control) key the entry on the literal
  // bytes of the cacheable prefix. A cross-boundary HIT is therefore impossible
  // unless two requests carry a byte-identical cacheable prefix — which requires
  // the same companion identity block AND the same contact session block. We
  // prove the prefix hashes are distinct across both boundaries and that
  // verification is byte-exact (fail closed), so a hit can never serve one
  // companion/contact's cached prefix to another.
  function serialize(companionIdentity: string, sessionNote: string): {
    systemPrompt: string;
    staticPrefixText: string;
    sessionStablePrefixText: string;
  } {
    const staticPrefixText = `<character_foundation>\n${companionIdentity}\n</character_foundation>`;
    const sessionStablePrefixText = `${staticPrefixText}\n\n<orientation>\n${sessionNote}\n</orientation>`;
    const systemPrompt = `${sessionStablePrefixText}\n\n<runtime_context>\nmood: curious\n</runtime_context>`;
    return { systemPrompt, staticPrefixText, sessionStablePrefixText };
  }

  it('produces distinct static-prefix hashes for distinct companions', () => {
    const a = serialize('You are Companion.', 'DM with Alice.');
    const b = serialize('You are Artemis.', 'DM with Alice.');
    const boundariesA = buildSystemPromptCacheBoundaries(a);
    const boundariesB = buildSystemPromptCacheBoundaries(b);
    expect(boundariesA.staticPrefixHash).not.toBe(boundariesB.staticPrefixHash);
    // A's boundaries can never validate against B's system prompt: no shared
    // content-hash cache entry.
    expect(verifySystemPromptCacheBoundaries(b.systemPrompt, boundariesA)).toBe(false);
    expect(verifySystemPromptCacheBoundaries(a.systemPrompt, boundariesA)).toBe(true);
  });

  it('produces distinct session-stable-prefix hashes for distinct contacts', () => {
    const alice = serialize('You are Companion.', 'DM with Alice.');
    const bob = serialize('You are Companion.', 'DM with Bob.');
    const boundariesAlice = buildSystemPromptCacheBoundaries(alice);
    const boundariesBob = buildSystemPromptCacheBoundaries(bob);
    // Same companion → identical static-prefix hash (the shared, non-private
    // identity block is legitimately cacheable across contacts)...
    expect(boundariesAlice.staticPrefixHash).toBe(boundariesBob.staticPrefixHash);
    // ...but the contact-scoped session-stable region differs, so the cacheable
    // region that contains contact content never shares an entry.
    expect(boundariesAlice.sessionStablePrefixHash).not.toBe(boundariesBob.sessionStablePrefixHash);
    expect(verifySystemPromptCacheBoundaries(bob.systemPrompt, boundariesAlice)).toBe(false);
  });
});
