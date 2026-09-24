/**
 * Test-only typing for Svelte's client proxy factory. The node test
 * environment compiles `.svelte.ts` modules for SSR, where `$state` never
 * creates a proxy, so the snapshot detachment regression needs the real client
 * `proxy` to exercise an actual reactive proxy. Only the used signature is
 * declared; production code must not import Svelte internals.
 */
declare module 'svelte/internal/client' {
  export function proxy<T>(value: T): T;
}
