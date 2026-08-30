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
      beforeTokens: 19_386,
      afterTokens: 23_401,
      deltaTokens: 4_015,
      beforeBytes: 91_147,
      afterBytes: 109_124,
      providerSchemaHash: 'd8436da57bb7a8cac533956ed6a55f22ae2d9da3bfc4a65c591c6e9ac92dc78b',
      parameterSchemaHash: '6099367af0363ed2a6f745d53b75cad7075032ed8af611b0c6c672e5c3feeea8',
    });

    // The additional description tokens affect an uncached request. A stable
    // serialized prefix is eligible for provider prompt caching where that
    // provider supports it; this fixture does not claim or simulate a cache hit.
  });
});
