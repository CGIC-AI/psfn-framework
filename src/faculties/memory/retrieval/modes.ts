import type {
  RetrievalCallerContext,
  RetrievalMode,
  RetrievalModeInput,
} from '../types.js';

export function cloneRetrievalModeInput(input: RetrievalModeInput | undefined): RetrievalModeInput | undefined {
  if (input === undefined) return undefined;
  return Array.isArray(input) ? [...input] : input;
}

export function cloneRetrievalCallerContext(
  callerContext: RetrievalCallerContext | undefined,
): RetrievalCallerContext | undefined {
  if (!callerContext) return undefined;
  return {
    ...callerContext,
    ...(callerContext.retrievalMode !== undefined
      ? { retrievalMode: cloneRetrievalModeInput(callerContext.retrievalMode) }
      : {}),
  };
}

function appendRetrievalModes(target: Set<RetrievalMode>, input: unknown): void {
  if (Array.isArray(input)) {
    for (const entry of input) appendRetrievalModes(target, entry);
    return;
  }
  if (typeof input !== 'string') return;

  const normalized = input.trim().toLowerCase();
  if (!normalized) return;

  const tokens = normalized.split(/[+,|]/g)
    .map(token => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (token === 'default' || token === 'temporal' || token === 'reflection') {
      target.add(token);
    }
  }
}

export function normalizeRetrievalModes(
  callerContext?: RetrievalCallerContext,
  retrievalMode?: RetrievalModeInput,
): ReadonlySet<RetrievalMode> {
  const modes = new Set<RetrievalMode>();
  appendRetrievalModes(modes, retrievalMode);
  appendRetrievalModes(modes, callerContext?.retrievalMode);
  if (modes.size > 1 && modes.has('default')) {
    modes.delete('default');
  }
  return modes;
}

export function serializeRetrievalModes(
  callerContext?: RetrievalCallerContext,
  retrievalMode?: RetrievalModeInput,
): string {
  const modes = normalizeRetrievalModes(callerContext, retrievalMode);
  if (modes.size === 0) return '';
  const orderedModes: RetrievalMode[] = ['default', 'temporal', 'reflection'];
  return orderedModes.filter(mode => modes.has(mode)).join(',');
}
