import { AsyncLocalStorage } from 'node:async_hooks';

export interface CapturedSessionOwnerIdentity {
  logicalSessionId: string;
  sourceChannelId?: string;
}

interface CapturedSessionOwnerContext extends CapturedSessionOwnerIdentity {
  manager: object;
}

const capturedSessionOwnerStorage = new AsyncLocalStorage<CapturedSessionOwnerContext>();

export function getCapturedSessionOwner(
  manager: object,
): CapturedSessionOwnerIdentity | null {
  const context = capturedSessionOwnerStorage.getStore();
  if (context?.manager !== manager) return null;
  return {
    logicalSessionId: context.logicalSessionId,
    ...(context.sourceChannelId ? { sourceChannelId: context.sourceChannelId } : {}),
  };
}

export function runWithCapturedSessionOwner<T>(
  manager: object,
  identity: CapturedSessionOwnerIdentity,
  operation: () => T,
): T {
  const logicalSessionId = identity.logicalSessionId.trim();
  const sourceChannelId = identity.sourceChannelId?.trim();
  if (!logicalSessionId) {
    throw new Error('Captured session owner must not be empty');
  }
  if (identity.sourceChannelId !== undefined && !sourceChannelId) {
    throw new Error('Captured session physical source must not be empty');
  }
  const currentOwner = capturedSessionOwnerStorage.getStore();
  if (currentOwner?.manager === manager
    && (currentOwner.logicalSessionId !== logicalSessionId
      || (sourceChannelId !== undefined
        && currentOwner.sourceChannelId !== undefined
        && currentOwner.sourceChannelId !== sourceChannelId))) {
    throw new Error(
      `Captured session owner mismatch: active owner is "${currentOwner.logicalSessionId}" `
      + `but nested work requested "${logicalSessionId}"`,
    );
  }
  const effectiveSourceChannelId = sourceChannelId
    ?? (currentOwner?.manager === manager ? currentOwner.sourceChannelId : undefined);
  return capturedSessionOwnerStorage.run({
    manager,
    logicalSessionId,
    ...(effectiveSourceChannelId ? { sourceChannelId: effectiveSourceChannelId } : {}),
  }, operation);
}
