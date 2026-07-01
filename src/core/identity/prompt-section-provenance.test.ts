import { describe, expect, it } from 'vitest';
import {
  buildTurnPromptSectionScopeResolver,
  resolveTurnPromptScopeKeys,
} from './prompt-section-provenance.js';
import { extractWrappedPromptSections } from './prompt-sections.js';

/**
 * Bead psfn-framework-u9jo.3 AC2: a group turn labels a core-memory block with
 * the room scope key; a DM turn labels it with the contact scope key. Every
 * prompt block also exposes its producer module (AC1).
 */
const CORE_MEMORY_BLOCK = [
  '<core_memory>',
  'persona: Purrsephone, a long-lived companion.',
  'human: Raul, the operator.',
  '</core_memory>',
  '',
  '<core_profile>',
  'Distilled semantic profile for the current contact.',
  '</core_profile>',
].join('\n');

describe('prompt section scope provenance labels', () => {
  it('labels a core-memory block with the contact scope key on a DM turn', () => {
    const scopeKeys = resolveTurnPromptScopeKeys({
      canonicalContactKey: 'contact-42',
      channelId: 'discord:dm:contact-42',
      isDirectMessage: true,
    });
    const resolver = buildTurnPromptSectionScopeResolver(scopeKeys);
    const sections = extractWrappedPromptSections(CORE_MEMORY_BLOCK, resolver);

    const coreMemory = sections.find(section => section.id === 'core_memory');
    expect(coreMemory).toBeDefined();
    expect(coreMemory?.scopeProvenance?.scopeKey).toBe('dm:contact-42');
    expect(coreMemory?.scopeProvenance?.scopeClass).toBe('dm');
    expect(coreMemory?.scopeProvenance?.producer).toBe('core-memory.store');

    const coreProfile = sections.find(section => section.id === 'core_profile');
    expect(coreProfile?.scopeProvenance?.scopeKey).toBe('dm:contact-42');
    expect(coreProfile?.scopeProvenance?.producer).toBe('memory.retrieval.formatting');
  });

  it('labels a core-memory block with the room scope key on a group turn', () => {
    const scopeKeys = resolveTurnPromptScopeKeys({
      canonicalContactKey: 'contact-42',
      channelId: 'discord:guild:room-7',
      isDirectMessage: false,
    });
    const resolver = buildTurnPromptSectionScopeResolver(scopeKeys);
    const sections = extractWrappedPromptSections(CORE_MEMORY_BLOCK, resolver);

    const coreMemory = sections.find(section => section.id === 'core_memory');
    expect(coreMemory).toBeDefined();
    // DM-class block falls back to the room scope key on a group turn so the
    // operator sees where the block was actually keyed.
    expect(coreMemory?.scopeProvenance?.scopeKey).toBe('room:discord:guild:room-7');
    expect(coreMemory?.scopeProvenance?.scopeClass).toBe('dm');
  });

  it('keeps global blocks global and carries producer + volatility', () => {
    const scopeKeys = resolveTurnPromptScopeKeys({
      channelId: 'api:test',
      isDirectMessage: false,
    });
    const resolver = buildTurnPromptSectionScopeResolver(scopeKeys);
    const runtimeContext = '<runtime_context>\nNow: 2026-07-01\n</runtime_context>';
    const [section] = extractWrappedPromptSections(runtimeContext, resolver);

    expect(section?.scopeProvenance?.scopeKey).toBe('global');
    expect(section?.scopeProvenance?.scopeClass).toBe('global');
    expect(section?.scopeProvenance?.producer).toBe('substrate-agent.runtime-context');
    expect(section?.scopeProvenance?.volatility).toBe('volatile');
  });

  it('returns undefined provenance for unregistered blocks', () => {
    const scopeKeys = resolveTurnPromptScopeKeys({ channelId: 'api:test', isDirectMessage: false });
    const resolver = buildTurnPromptSectionScopeResolver(scopeKeys);
    expect(resolver('some_unknown_block')).toBeUndefined();
  });
});
