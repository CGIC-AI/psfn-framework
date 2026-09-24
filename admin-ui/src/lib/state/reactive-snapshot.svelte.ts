/** Svelte's snapshot result type (not exported by name from the `$state` namespace). */
type ReactiveSnapshot<T> = ReturnType<typeof $state.snapshot<T>>;

/** Detach a Svelte state proxy before mutating an editor draft. */
export function snapshotReactiveState<T>(value: T): ReactiveSnapshot<T> {
  return $state.snapshot(value);
}
