import { AsyncLocalStorage } from 'node:async_hooks';
import type { DisclosureLineage } from './contracts.js';

const MCP_METADATA_ACTIONS = new Set(['catalog', 'search', 'inspect', 'release']);

/**
 * Static discovery and local release results do not widen the generation's
 * data sensitivity. A remote call result and every other tool result retain
 * the existing confidential floor.
 */
export function admittedToolResultRequiresConfidentialFloor(input: {
  toolName: string;
  arguments: unknown;
}): boolean {
  if (input.toolName !== 'mcp' || typeof input.arguments !== 'object' || input.arguments === null) {
    return true;
  }
  const action = (input.arguments as Record<string, unknown>).action;
  return typeof action !== 'string' || !MCP_METADATA_ACTIONS.has(action);
}

export function applyAdmittedToolResultDisclosureFloor(
  lineage: DisclosureLineage | undefined,
  input: { toolName: string; arguments: unknown },
): DisclosureLineage | undefined {
  if (
    !lineage
    || lineage.effectiveSensitivity === 'confidential'
    || !admittedToolResultRequiresConfidentialFloor(input)
  ) {
    return lineage;
  }
  return { ...lineage, effectiveSensitivity: 'confidential' };
}

export interface McpTurnDisclosureContext {
  /** Read lazily so a screened tool result can tighten the lineage before the next model step. */
  getLineage(): DisclosureLineage | undefined;
}

const storage = new AsyncLocalStorage<McpTurnDisclosureContext>();

export function runWithMcpTurnDisclosureContext<T>(
  context: McpTurnDisclosureContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

export function getMcpTurnDisclosureContext(): McpTurnDisclosureContext | undefined {
  return storage.getStore();
}
