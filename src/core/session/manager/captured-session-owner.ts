import { AsyncLocalStorage } from 'node:async_hooks';

import type { MemoryScopeQuery } from '../../../faculties/memory/types.js';
import type { SessionEntry } from '../types.js';
import type { ConversationScope, ConversationScopeSpeaker } from '../conversation-scope.js';
import type {
  AutoCompactionBetweenTurnsParams,
  AutoCompactionRecentEntriesCaptureParams,
  SessionManagerTypeSurface,
} from './session-manager-type-surface.js';

export interface CapturedSessionOwnerIdentity {
  readonly logicalSessionId: string;
  readonly sourceChannelId: string;
}

/** Content-free relationship activity safe to project across channel scopes. */
export interface PrivateRelationshipActivitySummary {
  readonly lastDirectInteractionAtMs: number;
}

interface CapturedSessionOwnerContext extends CapturedSessionOwnerIdentity {
  manager: object;
}

export const CAPTURED_SESSION_OWNER_INVARIANT_CODE =
  'SESSION_CAPTURED_OWNER_INVARIANT' as const;

/**
 * Fail-closed invariant raised when admitted turn work attempts mutable
 * session resolution outside its captured owner. Tool handlers must propagate
 * this error to the outer execution boundary: its forensic message belongs in
 * telemetry, never in companion-visible tool content.
 */
export class CapturedSessionOwnerInvariantError extends Error {
  readonly code = CAPTURED_SESSION_OWNER_INVARIANT_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'CapturedSessionOwnerInvariantError';
  }
}

export function isCapturedSessionOwnerInvariantError(
  error: unknown,
): error is CapturedSessionOwnerInvariantError {
  return error instanceof CapturedSessionOwnerInvariantError
    || (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === CAPTURED_SESSION_OWNER_INVARIANT_CODE
    );
}

type Tail<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest]
  ? Rest
  : never;

type CaptureTurnSessionContextInput = Omit<
  Parameters<SessionManagerTypeSurface['captureTurnSessionContext']>[0],
  'channelId'
>;

type ResolveConversationScopeInput = Omit<
  Parameters<SessionManagerTypeSurface['resolveConversationScope']>[0],
  'channelId'
>;

type CapturedAutoCompactionParams = Omit<AutoCompactionBetweenTurnsParams, 'channelId'>;

type CapturedAutoCompactionRecentEntriesParams = Omit<
  AutoCompactionRecentEntriesCaptureParams,
  'channelId'
>;

export interface CapturedSessionReadOperations {
  buildContext: (
    ...args: Tail<Parameters<SessionManagerTypeSurface['buildContext']>>
  ) => ReturnType<SessionManagerTypeSurface['buildContext']>;
  captureTurnSessionContext: (
    input: CaptureTurnSessionContextInput,
  ) => ReturnType<SessionManagerTypeSurface['captureTurnSessionContext']>;
  getRecentMessages: (limit?: number) => SessionEntry[];
  getRecentMessagesAtOrBefore: (
    maxEntryId: number,
    limit: number,
  ) => SessionEntry[];
  getRoleEnvelopeRefsForEntries: (
    sessionEntryIds: readonly number[],
  ) => string[];
  scheduleAutoCompactionBetweenTurns: (
    params: CapturedAutoCompactionParams,
  ) => Promise<void>;
  captureAutoCompactionRecentEntries: (
    params: CapturedAutoCompactionRecentEntriesParams,
  ) => SessionEntry[];
  hasPendingAutoCompaction: () => boolean;
  getActiveFocusMemoryScopeQuery: () => MemoryScopeQuery | null;
  getRecentConversationSpeakers: () => ConversationScopeSpeaker[];
  getPrivateRelationshipActivity: (
    continuityUserId: string,
  ) => PrivateRelationshipActivitySummary | null;
  resolveConversationScope: (input: ResolveConversationScopeInput) => ConversationScope;
  reconcileSessionChannelFromDisk: (
  ) => ReturnType<SessionManagerTypeSurface['reconcileSessionChannelFromDisk']>;
}

interface CapturedSessionReadsFactoryResult {
  owner: CapturedSessionOwnerIdentity;
  operations: CapturedSessionReadOperations;
}

type CapturedSessionReadsFactory = (
  channelId: string,
) => CapturedSessionReadsFactoryResult;

const capturedSessionOwnerStorage = new AsyncLocalStorage<CapturedSessionOwnerContext>();

function normalizeCapturedSessionOwner(
  identity: CapturedSessionOwnerIdentity,
): CapturedSessionOwnerIdentity {
  const logicalSessionId = identity.logicalSessionId.trim();
  const sourceChannelId = identity.sourceChannelId.trim();
  if (!logicalSessionId) {
    throw new Error('Captured session owner must not be empty');
  }
  if (!sourceChannelId) {
    throw new Error('Captured session physical source must not be empty');
  }
  return Object.freeze({ logicalSessionId, sourceChannelId });
}

function getCapturedSessionOwner(
  manager: object,
): CapturedSessionOwnerIdentity | null {
  const context = capturedSessionOwnerStorage.getStore();
  if (context?.manager !== manager) return null;
  return {
    logicalSessionId: context.logicalSessionId,
    sourceChannelId: context.sourceChannelId,
  };
}

/**
 * Read the captured owner bound to `manager` for the current async scope, or
 * null when no admitted turn is active for this manager. Exposed so owner-bound
 * resolvers (e.g. SessionManager.resolveSessionChannelId) can fail closed on
 * mutable active-context resolution instead of silently leaking a different
 * session's identity into a captured scope.
 */
export function getCapturedSessionOwnerIdentity(
  manager: object,
): CapturedSessionOwnerIdentity | null {
  return getCapturedSessionOwner(manager);
}

export function assertNoCapturedSessionOwner(
  manager: object,
  callSite: string,
): void {
  const owner = getCapturedSessionOwner(manager);
  if (!owner) return;
  throw new Error(
    `${callSite} cannot run during an admitted turn owned by `
    + `"${owner.logicalSessionId}"; use CapturedSessionReads or `
    + 'resolveForeignSessionForTurn(reason, channelId, operation)',
  );
}

function assertCapturedSessionOwner(
  manager: object,
  expected: CapturedSessionOwnerIdentity,
  callSite: string,
): void {
  const owner = getCapturedSessionOwner(manager);
  if (!owner) {
    throw new Error(
      `${callSite} lost its admitted-turn session scope for `
      + `"${expected.logicalSessionId}"`,
    );
  }
  if (owner.logicalSessionId !== expected.logicalSessionId
    || owner.sourceChannelId !== expected.sourceChannelId) {
    throw new Error(
      `${callSite} expected admitted owner "${expected.logicalSessionId}" `
      + `from "${expected.sourceChannelId}" but the active owner is `
      + `"${owner.logicalSessionId}" from "${owner.sourceChannelId}"`,
    );
  }
}

function runCapturedSessionOwnerScope<T>(
  manager: object,
  identity: CapturedSessionOwnerIdentity,
  operation: () => T,
  allowOwnerChange: boolean,
): T {
  const normalized = normalizeCapturedSessionOwner(identity);
  const currentOwner = capturedSessionOwnerStorage.getStore();
  const ownerChanges = currentOwner?.manager === manager
    && (currentOwner.logicalSessionId !== normalized.logicalSessionId
      || currentOwner.sourceChannelId !== normalized.sourceChannelId);
  if (ownerChanges && !allowOwnerChange) {
    throw new Error(
      `CapturedSessionReads.run expected owner "${currentOwner.logicalSessionId}" `
      + `from "${currentOwner.sourceChannelId}" but nested work requested `
      + `"${normalized.logicalSessionId}" from "${normalized.sourceChannelId}"`,
    );
  }
  return capturedSessionOwnerStorage.run({
    manager,
    ...normalized,
  }, operation);
}

function runWithCapturedSessionOwner<T>(
  manager: object,
  identity: CapturedSessionOwnerIdentity,
  operation: () => T,
): T {
  return runCapturedSessionOwnerScope(manager, identity, operation, false);
}

function runWithForeignCapturedSessionOwner<T>(
  manager: object,
  identity: CapturedSessionOwnerIdentity,
  reason: string,
  operation: () => T,
): T {
  if (!reason.trim()) {
    throw new Error('Foreign captured-session scope requires a non-empty audit reason');
  }
  return runCapturedSessionOwnerScope(manager, identity, operation, true);
}

/**
 * Explicit admitted-turn session read surface.
 *
 * The owner is captured in the value, so owner-bound operations deliberately
 * omit channelId. ALS is only a secondary lifetime/context-loss tripwire: it
 * never changes which session an operation reads.
 */
export class CapturedSessionReads {
  readonly owner: CapturedSessionOwnerIdentity;
  private readonly manager: object;
  private readonly operations: CapturedSessionReadOperations;
  private readonly createForChannel: CapturedSessionReadsFactory;

  constructor(
    manager: object,
    owner: CapturedSessionOwnerIdentity,
    operations: CapturedSessionReadOperations,
    createForChannel: CapturedSessionReadsFactory,
  ) {
    this.manager = manager;
    this.owner = normalizeCapturedSessionOwner(owner);
    this.operations = operations;
    this.createForChannel = createForChannel;
  }

  run<T>(operation: () => T): T {
    return runWithCapturedSessionOwner(this.manager, this.owner, operation);
  }

  private assertScope(callSite: string): void {
    assertCapturedSessionOwner(this.manager, this.owner, callSite);
  }

  buildContext(
    ...args: Tail<Parameters<SessionManagerTypeSurface['buildContext']>>
  ): ReturnType<SessionManagerTypeSurface['buildContext']> {
    this.assertScope('CapturedSessionReads.buildContext');
    return this.operations.buildContext(...args);
  }

  captureTurnSessionContext(
    input: CaptureTurnSessionContextInput,
  ): ReturnType<SessionManagerTypeSurface['captureTurnSessionContext']> {
    this.assertScope('CapturedSessionReads.captureTurnSessionContext');
    return this.operations.captureTurnSessionContext(input);
  }

  getRecentMessages(limit?: number): SessionEntry[] {
    this.assertScope('CapturedSessionReads.getRecentMessages');
    return this.operations.getRecentMessages(limit);
  }

  getRecentMessagesAtOrBefore(maxEntryId: number, limit: number): SessionEntry[] {
    this.assertScope('CapturedSessionReads.getRecentMessagesAtOrBefore');
    return this.operations.getRecentMessagesAtOrBefore(maxEntryId, limit);
  }

  getRoleEnvelopeRefsForEntries(sessionEntryIds: readonly number[]): string[] {
    this.assertScope('CapturedSessionReads.getRoleEnvelopeRefsForEntries');
    return this.operations.getRoleEnvelopeRefsForEntries(sessionEntryIds);
  }

  scheduleAutoCompactionBetweenTurns(params: CapturedAutoCompactionParams): Promise<void> {
    this.assertScope('CapturedSessionReads.scheduleAutoCompactionBetweenTurns');
    return this.operations.scheduleAutoCompactionBetweenTurns(params);
  }

  captureAutoCompactionRecentEntries(
    params: CapturedAutoCompactionRecentEntriesParams,
  ): SessionEntry[] {
    this.assertScope('CapturedSessionReads.captureAutoCompactionRecentEntries');
    return this.operations.captureAutoCompactionRecentEntries(params);
  }

  hasPendingAutoCompaction(): boolean {
    this.assertScope('CapturedSessionReads.hasPendingAutoCompaction');
    return this.operations.hasPendingAutoCompaction();
  }

  getActiveFocusMemoryScopeQuery(): MemoryScopeQuery | null {
    this.assertScope('CapturedSessionReads.getActiveFocusMemoryScopeQuery');
    return this.operations.getActiveFocusMemoryScopeQuery();
  }

  getRecentConversationSpeakers(): ConversationScopeSpeaker[] {
    this.assertScope('CapturedSessionReads.getRecentConversationSpeakers');
    return this.operations.getRecentConversationSpeakers();
  }

  getPrivateRelationshipActivity(
    continuityUserId: string,
  ): PrivateRelationshipActivitySummary | null {
    this.assertScope('CapturedSessionReads.getPrivateRelationshipActivity');
    return this.operations.getPrivateRelationshipActivity(continuityUserId);
  }

  resolveConversationScope(input: ResolveConversationScopeInput): ConversationScope {
    this.assertScope('CapturedSessionReads.resolveConversationScope');
    return this.operations.resolveConversationScope(input);
  }

  reconcileSessionChannelFromDisk(
  ): ReturnType<SessionManagerTypeSurface['reconcileSessionChannelFromDisk']> {
    this.assertScope('CapturedSessionReads.reconcileSessionChannelFromDisk');
    return this.operations.reconcileSessionChannelFromDisk();
  }

  resolveForeignSessionForTurn<T>(
    reason: string,
    channelId: string,
    operation: (reads: CapturedSessionReads) => T,
  ): T {
    this.assertScope('CapturedSessionReads.resolveForeignSessionForTurn');
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new Error(
        'CapturedSessionReads.resolveForeignSessionForTurn requires a non-empty audit reason',
      );
    }
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
      throw new Error(
        'CapturedSessionReads.resolveForeignSessionForTurn requires a non-empty channelId',
      );
    }
    const foreign = this.createForChannel(normalizedChannelId);
    const foreignReads = new CapturedSessionReads(
      this.manager,
      foreign.owner,
      foreign.operations,
      this.createForChannel,
    );
    return runWithForeignCapturedSessionOwner(
      this.manager,
      foreignReads.owner,
      normalizedReason,
      () => operation(foreignReads),
    );
  }
}
