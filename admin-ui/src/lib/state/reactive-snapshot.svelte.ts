/** Detach a Svelte state proxy before mutating an editor draft. */
export function snapshotReactiveState<T>(value: T): T {
  return $state.snapshot(value);
}
