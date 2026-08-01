import { AsyncLocalStorage } from 'node:async_hooks';
import type { DisclosureLineage } from './contracts.js';

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
