import type { EventBus, EventMap, EventName } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

/**
 * Operator-extensible hook registry (Hermes hooks.py pattern, bead
 * vvf.2).
 *
 * TRUST MODEL
 * Hooks are operator-authored code loaded from the companion's Personal
 * Workspace (`WORKSPACE_PATH/hooks/`, see hook-loader.ts). They sit at the
 * same trust level as workspace skills and installed modules: the operator
 * already controls the deployment, and loading a hook executes its handler
 * module in-process. What hooks deliberately do NOT get is runtime
 * capability. Handlers receive data only — a redacted, structured-cloned
 * event payload — never tool-execution ports, send/egress capabilities,
 * stores, config surfaces, or the EventBus itself. A lifecycle handler
 * cannot influence the pipeline: dispatch is fire-and-forget, return values
 * are discarded, and errors are caught and logged (the one deliberate
 * catch-and-log in this module; that IS the contract).
 *
 * PAYLOAD REDACTION
 * Events whose bus payloads can carry partner content (message text,
 * response text, forensic error text) are projected to content-free shapes —
 * ids, enums, counts, lengths — before dispatch, matching the audit-sink
 * posture in `src/channels/backplane/companion-relay/redaction.ts` and the
 * event-bus §19 do-not-log convention. Hooks never see raw partner content.
 *
 * INVOCATION MODES
 * The registration model and matcher are invocation-agnostic so the future
 * synchronous pre_tool_use decision path (bead 7ym.3 /
 * 7ym.3.1) can reuse them:
 *  - `async_lifecycle` (this bead, the only executed mode): declared
 *    lifecycle events map to EventBus subscriptions restricted to the
 *    HOOK_SUBSCRIBABLE_EVENTS allowlist; dispatch is async and NEVER blocks
 *    the emitting pipeline.
 *  - `sync_decision` (future, 7ym.3.1): registrations are accepted and
 *    listed so the sync path can be layered onto the same registry, but no
 *    execution path exists here and the workspace loader rejects manifests
 *    that request the mode. Do not add evaluation semantics in this module
 *    without that bead.
 *
 * PROCESS PLACEMENT
 * The module lives on the gateway/boundary surface (the file both vvf.2 and
 * 7ym.3 name), but the lifecycle consumer attaches to the AGENT-process bus
 * via startup composition: every allowlisted event is emitted there, and the
 * future sync pre-tool chokepoint (gateToolWithCapabilities) runs there too.
 * Workspace scanning mirrors the skills-faculty precedent of direct node:fs
 * reads at agent startup.
 */

const log = createComponentLogger('HookRegistry');

/**
 * Curated allowlist of lifecycle events operator hooks may subscribe to.
 * Fail-closed: any manifest event pattern that does not resolve to at least
 * one of these names rejects the hook at load. Internal events stay
 * internal — extending this list is a deliberate, reviewed decision (each
 * addition needs a redacting projector in HOOK_EVENT_PROJECTORS; the
 * exhaustive mapped type enforces that at compile time).
 *
 * Every listed event is emitted on the AGENT-process bus, where the
 * lifecycle consumer attaches (composition wires the registry in the agent
 * process; `message.received`/`message.sent` are gateway-bus-only and
 * `session.created` has no production emit site, so none of them are
 * allowlisted — an operator hook must never subscribe to an event that can
 * silently never fire in split production).
 */
export const HOOK_SUBSCRIBABLE_EVENTS = [
  'agent.turn.start',
  'agent.turn.end',
  'agent.tool.start',
  'agent.tool.end',
  'agent.compaction.start',
  'agent.compaction.end',
  'agent.retry.start',
  'agent.retry.end',
  'session.compacted',
  'system.ready',
  'system.shutdown',
] as const;

export type HookSubscribableEventName = typeof HOOK_SUBSCRIBABLE_EVENTS[number];

export function isHookSubscribableEvent(value: unknown): value is HookSubscribableEventName {
  return typeof value === 'string'
    && (HOOK_SUBSCRIBABLE_EVENTS as readonly string[]).includes(value);
}

/**
 * Content-free correlation fields copied through when the bus payload carries
 * them (events spread `Partial<CorrelationMetadata>` at the top level).
 */
const CORRELATION_PROJECTION_KEYS = [
  'companionId',
  'sessionId',
  'turnId',
  'requestId',
  'channelId',
  'channelType',
] as const;

function projectCorrelation(payload: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of CORRELATION_PROJECTION_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      projected[key] = value;
    }
  }
  return projected;
}

type HookPayloadProjector<E extends HookSubscribableEventName> = (
  payload: EventMap[E],
) => Record<string, unknown>;

/**
 * Per-event redaction projectors. Every allowlisted event MUST have one (the
 * mapped type fails compilation otherwise). Projectors return content-free
 * data: partner text becomes a length, forensic error text becomes a flag.
 */
const HOOK_EVENT_PROJECTORS: { [E in HookSubscribableEventName]: HookPayloadProjector<E> } = {
  'agent.turn.start': payload => ({
    ...projectCorrelation(payload),
    channelId: payload.message.channelId,
    channelType: payload.message.channelType,
    messageId: payload.message.id,
    authorId: payload.message.authorId,
    isDirectMessage: payload.message.isDirectMessage === true,
    contentLength: payload.message.content.length,
    attachmentCount: payload.message.attachments?.length ?? 0,
  }),
  'agent.turn.end': payload => ({
    ...projectCorrelation(payload),
    channelId: payload.message.channelId,
    channelType: payload.message.channelType,
    messageId: payload.message.id,
    authorId: payload.message.authorId,
    contentLength: payload.message.content.length,
    responseLength: payload.response.content.length,
    responseAttachmentCount: payload.response.attachments?.length ?? 0,
  }),
  // Shard identifiers are dropped, matching the companion-relay redaction
  // posture (redaction.ts `redactToolActivity`).
  'agent.tool.start': payload => ({
    ...projectCorrelation(payload),
    channelId: payload.channelId,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
  }),
  'agent.tool.end': payload => ({
    ...projectCorrelation(payload),
    channelId: payload.channelId,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    outcome: payload.outcome,
    isError: payload.isError,
    // Forensic error text stays on the audit trail (§19 posture); hooks see
    // only that an error message existed.
    hasErrorMessage: typeof payload.errorMessage === 'string' && payload.errorMessage.length > 0,
  }),
  'agent.compaction.start': payload => ({
    channelId: payload.channelId,
    reason: payload.reason,
    tokensBefore: payload.tokensBefore,
    tokenBudget: payload.tokenBudget,
  }),
  'agent.compaction.end': payload => ({
    channelId: payload.channelId,
    tokensBefore: payload.tokensBefore,
    tokensAfter: payload.tokensAfter,
  }),
  'agent.retry.start': payload => ({
    channelId: payload.channelId,
    attempt: payload.attempt,
    maxAttempts: payload.maxAttempts,
    delayMs: payload.delayMs,
    // Provider error text can embed prompt fragments; hooks get a flag only.
    hasError: payload.error.length > 0,
  }),
  'agent.retry.end': payload => ({
    channelId: payload.channelId,
    success: payload.success,
    attempt: payload.attempt,
  }),
  'session.compacted': payload => ({
    channelId: payload.channelId,
    before: payload.before,
    after: payload.after,
  }),
  'system.ready': () => ({}),
  'system.shutdown': () => ({}),
};

/** Compile-time guard: every allowlisted event is a real EventMap event. */
type AssertSubscribableIsEventName = HookSubscribableEventName extends EventName ? true : never;
const _hookEventsAreEventNames: AssertSubscribableIsEventName = true;
void _hookEventsAreEventNames;

// ── Matcher ──

const TRAILING_WILDCARD_SUFFIX = '.*';

/**
 * Invocation-agnostic name matcher over dot-separated subjects. Used by the
 * async lifecycle path to expand manifest event patterns against the
 * subscribable-event allowlist; designed for reuse by the future sync
 * pre_tool_use path over tool names/aliases (bead 7ym.3.1).
 *
 * Grammar (fail-closed — anything else is invalid):
 *  - exact subject name: `agent.tool.end`
 *  - trailing segment wildcard: `agent.tool.*` (matches `agent.tool.start`,
 *    not `agent.toolcall.start`, not `agent.tool` itself)
 * A bare `*` or an embedded `*` is rejected: hooks must name what they
 * subscribe to.
 */
export class HookMatcher {
  private readonly exact = new Set<string>();
  private readonly prefixes: string[] = [];
  readonly patterns: readonly string[];

  constructor(patterns: readonly string[]) {
    const errors = HookMatcher.validatePatterns(patterns);
    if (errors.length > 0) {
      throw new Error(`Invalid hook matcher patterns: ${errors.join('; ')}`);
    }
    this.patterns = [...patterns];
    for (const pattern of patterns) {
      if (pattern.endsWith(TRAILING_WILDCARD_SUFFIX)) {
        this.prefixes.push(pattern.slice(0, -1));
      } else {
        this.exact.add(pattern);
      }
    }
  }

  /** Returns one error message per invalid pattern; empty means valid. */
  static validatePatterns(patterns: readonly string[]): string[] {
    const errors: string[] = [];
    if (patterns.length === 0) {
      errors.push('at least one pattern is required');
      return errors;
    }
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || pattern.trim().length === 0) {
        errors.push('patterns must be non-empty strings');
        continue;
      }
      if (pattern !== pattern.trim()) {
        errors.push(`pattern has surrounding whitespace: "${pattern}"`);
        continue;
      }
      const starIndex = pattern.indexOf('*');
      if (starIndex === -1) continue;
      if (!pattern.endsWith(TRAILING_WILDCARD_SUFFIX)
        || starIndex !== pattern.length - 1
        || pattern === TRAILING_WILDCARD_SUFFIX) {
        errors.push(
          `unsupported wildcard in "${pattern}" (only a trailing ".*" segment is allowed)`,
        );
      }
    }
    return errors;
  }

  matches(subject: string): boolean {
    if (this.exact.has(subject)) return true;
    return this.prefixes.some(prefix =>
      subject.startsWith(prefix) && subject.length > prefix.length);
  }

  /**
   * Resolve the patterns against a candidate set. `unmatchedPatterns` lists
   * every pattern that matched no candidate — callers reject fail-closed on a
   * non-empty list rather than silently subscribing to nothing.
   */
  expand(candidates: readonly string[]): { matched: string[]; unmatchedPatterns: string[] } {
    const matched = new Set<string>();
    const unmatchedPatterns: string[] = [];
    for (const pattern of this.patterns) {
      const single = new HookMatcher([pattern]);
      const hits = candidates.filter(candidate => single.matches(candidate));
      if (hits.length === 0) {
        unmatchedPatterns.push(pattern);
        continue;
      }
      for (const hit of hits) matched.add(hit);
    }
    return { matched: [...matched], unmatchedPatterns };
  }
}

// ── Handler contracts ──

export interface HookLifecycleEventEnvelope {
  /** Registered hook name receiving this dispatch. */
  hook: string;
  event: HookSubscribableEventName;
  /** Redacted, structured-cloned projection — safe to mutate, goes nowhere. */
  payload: Record<string, unknown>;
  /** Dispatch wall-clock time (ms epoch). */
  timestamp: number;
}

export type HookLifecycleHandler = (
  envelope: HookLifecycleEventEnvelope,
) => void | Promise<void>;

export type HookInvocationMode = 'async_lifecycle' | 'sync_decision';

interface HookRegistrationBase {
  /** Unique hook name; duplicate registration is rejected. */
  name: string;
  description?: string;
  /** Provenance for logs (absolute manifest path, or a caller-chosen tag). */
  sourcePath: string;
}

export interface AsyncLifecycleHookRegistration extends HookRegistrationBase {
  mode: 'async_lifecycle';
  /** Expanded, allowlist-validated event names (loader resolves patterns). */
  events: readonly HookSubscribableEventName[];
  handler: HookLifecycleHandler;
}

/**
 * Registration-model placeholder for the synchronous pre_tool_use decision
 * path (bead 7ym.3.1). The registry accepts and lists these so the
 * sync path can reuse the same registration/matcher model, but this module
 * provides NO execution path for them and the workspace loader rejects
 * manifests requesting the mode until that bead lands.
 */
export interface SyncDecisionHookRegistration extends HookRegistrationBase {
  mode: 'sync_decision';
  /** Subject matcher (e.g. tool names/aliases) for the future decision path. */
  matcher: HookMatcher;
  /** Decision contract is defined by 7ym.3.1; opaque until then. */
  handler: (input: Record<string, unknown>) => unknown;
}

export type HookRegistration =
  | AsyncLifecycleHookRegistration
  | SyncDecisionHookRegistration;

export interface HookDispatchStats {
  name: string;
  mode: HookInvocationMode;
  events: readonly string[];
  invocations: number;
  failures: number;
  lastError?: string;
  lastErrorAtMs?: number;
}

interface HookRuntimeState {
  registration: HookRegistration;
  invocations: number;
  failures: number;
  lastError?: string;
  lastErrorAtMs?: number;
}

// ── Registry ──

export class HookRegistry {
  private readonly hooks = new Map<string, HookRuntimeState>();
  private readonly lifecycleIndex = new Map<HookSubscribableEventName, HookRuntimeState[]>();
  private readonly subscriptions = new Map<HookSubscribableEventName, () => void>();
  private attachedBus: EventBus | null = null;

  /**
   * Register a validated hook. Throws on duplicate names, empty event lists,
   * or non-allowlisted events — callers loading untrusted-shaped manifests
   * (the workspace loader) convert throws into rejected-with-reason records;
   * a throw here never crashes startup.
   */
  register(registration: HookRegistration): void {
    const name = registration.name.trim();
    if (!name) {
      throw new Error('Hook registration requires a non-empty name');
    }
    if (this.hooks.has(name)) {
      throw new Error(`Hook "${name}" is already registered`);
    }

    if (registration.mode === 'async_lifecycle') {
      if (registration.events.length === 0) {
        throw new Error(`Hook "${name}" declares no lifecycle events`);
      }
      const unknown = registration.events.filter(event => !isHookSubscribableEvent(event));
      if (unknown.length > 0) {
        throw new Error(
          `Hook "${name}" declares non-subscribable events: ${unknown.join(', ')}`,
        );
      }
      if (typeof registration.handler !== 'function') {
        throw new Error(`Hook "${name}" handler must be a function`);
      }
    }

    const state: HookRuntimeState = { registration, invocations: 0, failures: 0 };
    this.hooks.set(name, state);

    if (registration.mode === 'async_lifecycle') {
      for (const event of new Set(registration.events)) {
        const bucket = this.lifecycleIndex.get(event) ?? [];
        bucket.push(state);
        this.lifecycleIndex.set(event, bucket);
        if (this.attachedBus) this.subscribe(this.attachedBus, event);
      }
    }
  }

  list(mode?: HookInvocationMode): HookRegistration[] {
    const registrations = [...this.hooks.values()].map(state => state.registration);
    return mode ? registrations.filter(reg => reg.mode === mode) : registrations;
  }

  stats(): HookDispatchStats[] {
    return [...this.hooks.values()].map(state => ({
      name: state.registration.name,
      mode: state.registration.mode,
      events: state.registration.mode === 'async_lifecycle'
        ? [...state.registration.events]
        : [...state.registration.matcher.patterns],
      invocations: state.invocations,
      failures: state.failures,
      ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
      ...(state.lastErrorAtMs !== undefined ? { lastErrorAtMs: state.lastErrorAtMs } : {}),
    }));
  }

  /**
   * Wire the async lifecycle side onto an EventBus. Only events with at least
   * one registered async hook are subscribed; hooks registered later while
   * attached subscribe their events dynamically. Attaching twice is a wiring
   * bug and fails closed.
   */
  attachLifecycleConsumer(eventBus: EventBus): void {
    if (this.attachedBus) {
      throw new Error('HookRegistry lifecycle consumer is already attached');
    }
    this.attachedBus = eventBus;
    for (const event of this.lifecycleIndex.keys()) {
      this.subscribe(eventBus, event);
    }
  }

  /** Remove all bus subscriptions (shutdown/tests). */
  detachLifecycleConsumer(): void {
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
    this.attachedBus = null;
  }

  private subscribe(eventBus: EventBus, event: HookSubscribableEventName): void {
    if (this.subscriptions.has(event)) return;
    // The bus handler is synchronous and returns immediately: hook execution
    // is fire-and-forget and can never block or delay the emitting pipeline.
    const unsubscribe = eventBus.on(event, data => {
      this.dispatchLifecycle(event, data);
    });
    this.subscriptions.set(event, unsubscribe);
  }

  private dispatchLifecycle<E extends HookSubscribableEventName>(
    event: E,
    data: EventMap[E],
  ): void {
    const states = this.lifecycleIndex.get(event);
    if (!states || states.length === 0) return;

    let projected: Record<string, unknown>;
    try {
      projected = HOOK_EVENT_PROJECTORS[event](data);
    } catch (error) {
      // Projection is registry code, not operator code — but a projection
      // failure still must not break the emitting pipeline. Skip dispatch
      // loudly instead.
      log.error(`Hook payload projection failed for "${event}"; dispatch skipped`, {
        event,
        error: toErrorMessage(error),
      });
      return;
    }

    const timestamp = Date.now();
    for (const state of states) {
      if (state.registration.mode !== 'async_lifecycle') continue;
      const envelope: HookLifecycleEventEnvelope = {
        hook: state.registration.name,
        event,
        payload: structuredClone(projected),
        timestamp,
      };
      state.invocations += 1;
      // Deliberate catch-and-log: operator handler failures are recorded and
      // logged, never propagated, never blocking (the core vvf.2 contract).
      try {
        const result = state.registration.handler(envelope);
        void Promise.resolve(result).catch((error: unknown) => {
          this.recordFailure(state, event, error);
        });
      } catch (error) {
        this.recordFailure(state, event, error);
      }
    }
  }

  private recordFailure(state: HookRuntimeState, event: string, error: unknown): void {
    state.failures += 1;
    state.lastError = toErrorMessage(error);
    state.lastErrorAtMs = Date.now();
    log.warn(`Operator hook "${state.registration.name}" failed on "${event}" (error contained; pipeline unaffected)`, {
      hook: state.registration.name,
      event,
      sourcePath: state.registration.sourcePath,
      failures: state.failures,
      error: state.lastError,
    });
  }
}
