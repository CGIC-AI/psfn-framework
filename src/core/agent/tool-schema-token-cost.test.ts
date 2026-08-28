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
      coreTools: 24,
      extendedTools: 7,
      totalTools: 31,
      includesLibrary: false,
      beforeTokens: 18_312,
      afterTokens: 22_063,
      deltaTokens: 3_751,
      beforeBytes: 86_238,
      afterBytes: 102_945,
      providerSchemaHash: 'ae1d03e819979e7e9110249d6263393261ab6117c345e1ae9a5f6f72ed9707d3',
      parameterSchemaHash: '4390f14154693d153f8adb7ad9c7b77902584968d4e822728ad931ac7fcbee66',
    });

    // The additional description tokens affect an uncached request. A stable
    // serialized prefix is eligible for provider prompt caching where that
    // provider supports it; this fixture does not claim or simulate a cache hit.
  });
});
