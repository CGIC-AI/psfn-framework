export function combineAbortSignal(
  primary?: AbortSignal,
  secondary?: AbortSignal,
): AbortSignal | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const abortSignalAny = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (abortSignalAny) {
    return abortSignalAny([primary, secondary]);
  }

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  primary.addEventListener('abort', onAbort, { once: true });
  secondary.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
