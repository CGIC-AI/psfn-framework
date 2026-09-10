import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentTool } from '../../boundary/pi-agent/index.js';
import { toPiTools } from '../../primitives/llm/conversion.js';
import { countTokens } from '../../primitives/llm/tokens.js';
import type { ToolSchema } from '../../shared/contracts/runtime.js';
import { PRE_DESCRIPTION_REWRITE_TOOL_DESCRIPTIONS } from './tool-schema-token-cost.fixture.js';
import { createProviderFactoryToolCatalog } from './tool-surface/canonical-tool-catalog.test-support.js';
import {
  CANONICAL_FIRST_PARTY_TOOL_SURFACES,
  resolveToolPresentationRank,
} from './tool-surface/registry.js';

const FIXTURE_NAME = 'agent-state-tools-provider-v2';

function orderLikeAgentState(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
  return [...tools].sort((left, right) => {
    const rankDelta = resolveToolPresentationRank(left.name) - resolveToolPresentationRank(right.name);
    return rankDelta !== 0 ? rankDelta : left.name.localeCompare(right.name);
  });
}

function serializeProviderSchemas(tools: readonly AgentTool<any>[]): string {
  const wireSchemas: ToolSchema[] = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as Record<string, unknown>,
  }));
  return JSON.stringify(toPiTools(wireSchemas));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('full callable catalog schema token cost', () => {
  it('measures the fixed pre/post-description provider payload with the real schemas', () => {
    const afterTools = orderLikeAgentState(createProviderFactoryToolCatalog());
    const missingBaseline = afterTools
      .map(tool => tool.name)
      .filter(name => PRE_DESCRIPTION_REWRITE_TOOL_DESCRIPTIONS[name] === undefined);
    expect(missingBaseline).toEqual([]);

    const beforeTools = afterTools.map(tool => ({
      ...tool,
      description: PRE_DESCRIPTION_REWRITE_TOOL_DESCRIPTIONS[tool.name]!,
    }));
    const beforeSerialized = serializeProviderSchemas(beforeTools);
    const afterSerialized = serializeProviderSchemas(afterTools);
    const parameterSchemas = JSON.stringify(afterTools.map(tool => ({
      name: tool.name,
      parameters: tool.parameters,
    })));
    const coreCount = CANONICAL_FIRST_PARTY_TOOL_SURFACES
      .filter(surface => surface.exposure === 'core').length;
    const extendedCount = afterTools.length - coreCount;
    const beforeTokens = countTokens(`${FIXTURE_NAME}\n${beforeSerialized}`);
    const afterTokens = countTokens(`${FIXTURE_NAME}\n${afterSerialized}`);

    expect({
      fixture: FIXTURE_NAME,
      coreTools: coreCount,
      extendedTools: extendedCount,
      totalTools: afterTools.length,
      includesLibrary: afterTools.some(tool => tool.name === 'library'),
      beforeTokens,
      afterTokens,
      deltaTokens: afterTokens - beforeTokens,
      beforeBytes: Buffer.byteLength(beforeSerialized),
      afterBytes: Buffer.byteLength(afterSerialized),
      providerSchemaHash: sha256(afterSerialized),
      parameterSchemaHash: sha256(parameterSchemas),
    }).toEqual({
      fixture: 'agent-state-tools-provider-v2',
      coreTools: 25,
      extendedTools: 7,
      totalTools: 32,
      includesLibrary: false,
      // n66dn.3 (Eidoverse plane: world move/perceive/act) +1440 bytes / +383 tokens pre, +2096 / +545 post.
      // psfn-framework-lpxg3.3 added the optional skill `base_version` binding:
      // +219 bytes / +42 tokens on both the pre- and post-description payloads.
      // psfn-framework-owffl.8 named the shell byte-range route in the fs and
      // shell guidance: +313 bytes / +66 tokens on the post-description payload.
      // psfn-framework-jbvwz added the world flight verbs (take_off, climb_to,
      // glide_to, land_at, fold_wings, unfold_wings, flight_status) to the act
      // verb enum and argument guidance: +641 bytes / +161 tokens on both payloads.
      // psfn-framework-2nsfo added the wiki world_notes_read / world_note actions
      // and their world / note_text / note_about fields: +644 bytes / +157 tokens.
      // psfn-framework-mlhfw added world perceive detail=snapshot and view: +378 bytes / +86 tokens.
      // psfn-framework-ae7c9 added the play_clip verb and its guidance: +159 bytes / +38 tokens.
      // 2nsfo's wiki actions joined the structured contract (description text only):
      // +129 bytes / +31 tokens on the post-description payload.
      beforeTokens: 20_253,
      afterTokens: 24_527,
      deltaTokens: 4_274,
      beforeBytes: 94_628,
      afterBytes: 113_703,
      providerSchemaHash: '6fe36876a89b5feb76ae32809cd2b27421a64cbbe91e733d5d3c9dd206d9bf28',
      parameterSchemaHash: '63b7d1c94185e17927431ac274756603f1634754f1cd31336d123df10ab04dab',
    });

    // The additional description tokens affect an uncached request. A stable
    // serialized prefix is eligible for provider prompt caching where that
    // provider supports it; this fixture does not claim or simulate a cache hit.
  });
});
