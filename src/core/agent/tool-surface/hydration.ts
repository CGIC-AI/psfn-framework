import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { WirableTool } from '../tool-wiring-validator.js';
import { getCanonicalToolSurface } from './registry.js';

export type ToolSurfaceCaller =
  | { readonly kind: 'companion' }
  | { readonly kind: 'shard'; readonly shardId: string };

export type CallerHydratableTool = WirableTool & {
  hydrateForCaller?: (caller: ToolSurfaceCaller) => AgentTool<any>;
};

export interface PolicyToolHydrationExpectation {
  readonly toolName: string;
  readonly enabled: boolean;
  readonly allowedActions: readonly string[];
  readonly source: string;
}

interface ToolCatalogLike {
  readonly core: readonly AgentTool<any>[];
  readonly extended: readonly AgentTool<any>[];
}

function extractStringLiterals(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const literals: string[] = typeof schema.const === 'string' ? [schema.const] : [];
  if (Array.isArray(schema.enum)) {
    literals.push(...schema.enum.filter((value): value is string => typeof value === 'string'));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const entries = schema[key];
    if (Array.isArray(entries)) {
      literals.push(...entries.flatMap(extractStringLiterals));
    }
  }
  return [...new Set(literals)];
}

function extractCanonicalActions(tool: AgentTool<any>): string[] {
  const canonical = getCanonicalToolSurface(tool.name);
  if (!canonical?.actions) return [];
  const parameters = isRecord(tool.parameters) ? tool.parameters : {};
  const properties = isRecord(parameters.properties) ? parameters.properties : {};
  const actionLiterals = new Set(extractStringLiterals(properties.action));
  return canonical.actions.filter(action => actionLiterals.has(action));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function hydrateToolForCaller<T extends AgentTool<any>>(
  tool: T,
  caller: ToolSurfaceCaller,
): T {
  const hydratable = tool as T & CallerHydratableTool;
  return (hydratable.hydrateForCaller?.(caller) ?? tool) as T;
}

/**
 * Fail-closed startup reconciliation for policy-gated first-party surfaces.
 * It checks tool presence and the exact canonical action list against both the
 * policy expectation and the metadata attached to the hydrated tool.
 */
export function assertPolicyToolHydration(
  catalog: ToolCatalogLike,
  expectations: readonly PolicyToolHydrationExpectation[],
): void {
  const tools = [...catalog.core, ...catalog.extended];
  for (const expectation of expectations) {
    const matches = tools.filter(tool => tool.name === expectation.toolName);
    if (!expectation.enabled) {
      if (matches.length > 0) {
        throw new Error(
          `Policy tool hydration divergence: ${expectation.toolName} is registered while disabled by ${expectation.source}`,
        );
      }
      continue;
    }
    if (matches.length === 0) {
      throw new Error(
        `Policy tool hydration divergence: ${expectation.toolName} is not registered although enabled by ${expectation.source}`,
      );
    }
    if (matches.length !== 1) {
      throw new Error(
        `Policy tool hydration divergence: ${expectation.toolName} is registered ${matches.length} times`,
      );
    }

    const tool = matches[0] as WirableTool;
    const metadata = tool.wiringMeta?.policyHydration;
    if (!metadata || metadata.source !== expectation.source) {
      throw new Error(
        `Policy tool hydration divergence: ${expectation.toolName} is missing authority metadata for ${expectation.source}`,
      );
    }
    const metadataActions = metadata.allowedActions;
    const expectedActions = [...expectation.allowedActions];
    const hydratedActions = extractCanonicalActions(tool);
    if (!sameStrings(metadataActions, expectedActions) || !sameStrings(hydratedActions, expectedActions)) {
      const unexpected = hydratedActions.filter(action => !expectedActions.includes(action));
      const missing = expectedActions.filter(action => !hydratedActions.includes(action));
      throw new Error(
        `Policy tool hydration divergence for ${expectation.toolName}: expected [${expectedActions.join(', ')}], `
        + `metadata [${metadataActions.join(', ')}], hydrated [${hydratedActions.join(', ')}]`
        + `${unexpected.length > 0 ? `, unexpected [${unexpected.join(', ')}]` : ''}`
        + `${missing.length > 0 ? `, missing [${missing.join(', ')}]` : ''}`,
      );
    }
  }
}
