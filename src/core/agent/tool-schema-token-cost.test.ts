import { describe, expect, it } from 'vitest';
import { countTokens } from '../../primitives/llm/tokens.js';
import {
  CANONICAL_FIRST_PARTY_TOOL_SURFACES,
  type CanonicalToolSurfaceEntry,
} from './tool-surface/registry.js';

const FIXTURE_NAME = 'canonical-registry-actions-v1';

function toProviderToolSchema(surface: CanonicalToolSurfaceEntry) {
  const actions = surface.actions ?? [];
  return {
    type: 'function',
    function: {
      name: surface.name,
      description: surface.description,
      parameters: {
        type: 'object',
        properties: actions.length > 0
          ? { action: { type: 'string', enum: actions } }
          : {},
        required: actions.length > 0 ? ['action'] : [],
      },
    },
  };
}

function fixtureTokens(surfaces: readonly CanonicalToolSurfaceEntry[]): number {
  return countTokens(`${FIXTURE_NAME}\n${JSON.stringify(surfaces.map(toProviderToolSchema))}`);
}

describe('always-loaded catalog schema token cost', () => {
  it('records the fixed canonical-registry before/after cost under prompt caching', () => {
    const core = CANONICAL_FIRST_PARTY_TOOL_SURFACES.filter(surface => surface.exposure === 'core');
    const extended = CANONICAL_FIRST_PARTY_TOOL_SURFACES.filter(surface => surface.exposure === 'extended');

    const coreOnlyTokens = fixtureTokens(core);
    const alwaysLoadedTokens = fixtureTokens(CANONICAL_FIRST_PARTY_TOOL_SURFACES);
    const deltaTokens = alwaysLoadedTokens - coreOnlyTokens;

    expect({
      fixture: FIXTURE_NAME,
      coreTools: core.length,
      extendedTools: extended.length,
      totalTools: CANONICAL_FIRST_PARTY_TOOL_SURFACES.length,
      coreOnlyTokens,
      alwaysLoadedTokens,
      deltaTokens,
    }).toEqual({
      fixture: 'canonical-registry-actions-v1',
      coreTools: 21,
      extendedTools: 7,
      totalTools: 28,
      coreOnlyTokens: 1_251,
      alwaysLoadedTokens: 1_632,
      deltaTokens: 381,
    });

    // The provider tool block is stable and prefix-cacheable after the first
    // request; keep the always-loaded incremental schema cost below 400 tokens.
    expect(deltaTokens).toBeLessThan(400);
  });
});
