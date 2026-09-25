import { it as vitestIt } from 'vitest';
import { runWithRequestContext } from '../primitives/llm/request-context.js';
import type { CorrelationMetadata } from '../shared/contracts/runtime.js';

type RequestContext = Partial<CorrelationMetadata>;

/**
 * Test cases that spawn subagents or shards run inside an admitted viewer
 * request context, as a real spawning turn does (psfn-framework-mzytp): a
 * spawn without one is refused.
 */
const OWNER_VIEWER_REQUEST_CONTEXT: RequestContext = {
  callType: 'tool',
  purpose: 'agent.turn',
  channelId: 'api:owner-console',
  viewerTrustLevel: 'primary',
  viewerChannelPrivacy: 'private',
};

type AnyTestFn = (...args: any[]) => any;

function wrap(fn: AnyTestFn | undefined, context: RequestContext): AnyTestFn | undefined {
  return fn ? (...args: unknown[]) => runWithRequestContext(context, async () => await fn(...args)) : undefined;
}

/** `it` whose cases (including `.each`, `.skip`, `.only`) run as `context`. */
export function viewerContextIt(context: RequestContext = OWNER_VIEWER_REQUEST_CONTEXT): typeof vitestIt {
  const base = (name: string, fn?: AnyTestFn, options?: number) => vitestIt(name, wrap(fn, context), options);
  const each = (table: readonly unknown[]) => (name: string, fn?: AnyTestFn, options?: number) =>
    vitestIt.each(table as unknown[])(name, wrap(fn, context) as AnyTestFn, options);
  const skip = (name: string, fn?: AnyTestFn, options?: number) => vitestIt.skip(name, wrap(fn, context), options);
  const only = (name: string, fn?: AnyTestFn, options?: number) => vitestIt.only(name, wrap(fn, context), options);
  return Object.assign(base, { each, skip, only, todo: vitestIt.todo }) as unknown as typeof vitestIt;
}
