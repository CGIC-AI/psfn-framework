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
import { selectHybridCodeModeWireTools } from './substrate-agent/tool-orchestration-runtime.js';

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
      coreTools: 27,
      extendedTools: 4,
      totalTools: 31,
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
      // psfn-framework-vcq8v.9 added the automata_bus note action, its text
      // field, and the read-notes-first / write-notes-last guidance:
      // +108 bytes / +27 tokens before, +213 bytes / +53 tokens after.
      // psfn-framework-vcq8v.4 replaced notify outreach_list/outreach_choose
      // (opportunity_id, disposition, destination_id) with outreach_send and
      // outreach_later: -659 bytes / -115 tokens after descriptions.
      // psfn-framework-9zgfd retired the web browse action (duplicate of fetch):
      // -49 bytes / -10 tokens before, -108 bytes / -23 tokens after.
      // psfn-framework-jequ8 documented the memory timeline today (UTC) default
      // on the date parameter: +54 bytes / +15 tokens.
      // psfn-framework-yy0r2 added the scratchpad scope parameter
      // (conversation | companion_global): +213 bytes / +40 tokens.
      // psfn-framework-e46hi reordered presentation ranks (memory/journal/orient
      // first, async letters demoted): +0 bytes / +0 tokens, hash updated.
      // psfn-framework-eoj3s.5 added direct companion DM `message` variant on
      // approved open dyads in `notify`: +511 bytes / +108 tokens.
      // psfn-framework-b3h5p.1 retired vault, letter, and companion beads tools
      // and removed standalone introspection consent actions from orient:
      // -6700 bytes / -1500 tokens before, -7544 bytes / -1682 tokens after.
      // psfn-framework-b3h5p.2 split concerns out of orient, split projects out
      // of wiki, un-overloaded notify send into send/initiate_companion/send_companion,
      // marked action required on all action-multiplexed tools, and compacted
      // descriptions into scannable bulleted contracts:
      // -226 bytes / -104 tokens before, -2897 bytes / -212 tokens after.
      // psfn-framework-b3h5p.3 retired redundant fs and repo wrapper tools in favor
      // of concise file_editor + gateway-observable bash shell (core):
      // -3878 bytes / -823 tokens before, -4378 bytes / -969 tokens after.
      // psfn-framework-b3h5p.4 added primary-turn `execute` REPL (core) and updated
      // `tool_search` for progressive TypeScript SDK discovery; full catalog grows
      // slightly (+1525 bytes / +338 tokens) while the upfront Hybrid Code Mode
      // provider wire payload drops ~87% below the pre-Phase-3 baseline (measured below).
      // psfn-framework-mv4xr declared north_star per-action idempotency
      // (list idempotent, writes effectful) through the existing schema key:
      // +172 bytes / +45 tokens on both payloads.
      // psfn-framework-xzt46 added self_status reasoning_read / reasoning_set /
      // reasoning_clear and their level / scope fields:
      // +680 bytes / +154 tokens before, +933 bytes / +211 tokens after.
      // Both together (shakedown candidate): the sum of the two deltas.
      beforeTokens: 18_265,
      afterTokens: 22_383,
      deltaTokens: 4_118,
      beforeBytes: 85_731,
      afterBytes: 101_968,
      providerSchemaHash: 'be7d0982337fea6021f1bf769015008c26a6b7b00ae491167f04dde861dcf765',
      parameterSchemaHash: 'f5af75020f79afb8d9606aeecca784a11402cfc581d8480cbbfb1553bee18ba1',
    });

    // The additional description tokens affect an uncached request. A stable
    // serialized prefix is eligible for provider prompt caching where that
    // provider supports it; this fixture does not claim or simulate a cache hit.
  });

  it('shrinks the upfront Hybrid Code Mode provider wire payload by >= 80% vs pre-Phase-3 baseline (b3h5p.4)', () => {
    const PRE_PHASE_3_BASELINE_TOKENS = 24_657;
    const fullCatalog = orderLikeAgentState(createProviderFactoryToolCatalog());
    const wireTools = selectHybridCodeModeWireTools(fullCatalog);
    const wireSerialized = serializeProviderSchemas(wireTools);
    const wireTokens = countTokens(`${FIXTURE_NAME}\n${wireSerialized}`);
    const reductionRatio = 1 - (wireTokens / PRE_PHASE_3_BASELINE_TOKENS);

    expect(wireTools.map(tool => tool.name).sort()).toEqual([
      'execute',
      'mcp',
      'notify',
      'publication',
      'response_control',
      'tool_search',
    ]);
    expect(reductionRatio).toBeGreaterThanOrEqual(0.8);
    expect(wireTokens).toBeLessThan(4_000);
  });
});
