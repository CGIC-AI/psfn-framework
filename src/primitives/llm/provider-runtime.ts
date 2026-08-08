// ── Provider Runtime Boundary ──
// Repository-owned seam over the upstream pi-ai provider dispatch API.
// Current implementation delegates to @mariozechner/pi-ai 0.73.1 globals;
// the later package upgrade replaces this adapter without touching call sites.

import {
  completeSimple,
  streamSimple,
  getModels,
  getProviders,
  getEnvApiKey,
} from '@mariozechner/pi-ai';
import type {
  Api,
  AssistantMessageEvent,
  Context as PiContext,
  KnownProvider,
  Model,
  SimpleStreamOptions,
} from '@mariozechner/pi-ai';

export type ProviderRuntimeCompleteResult = Awaited<ReturnType<typeof completeSimple>>;

export interface ProviderRuntime {
  /**
   * Dispatch a non-streaming completion for the selected model.
   */
  complete(
    model: Model<any>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): Promise<ProviderRuntimeCompleteResult>;

  /**
   * Dispatch a streaming completion for the selected model.
   */
  stream(
    model: Model<any>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): AsyncIterable<AssistantMessageEvent>;

  /**
   * Enumerate built-in provider identifiers known to the runtime.
   */
  getProviders(): readonly KnownProvider[];

  /**
   * Enumerate models registered for a built-in provider.
   */
  getModels(provider: KnownProvider): readonly Model<Api>[];

  /**
   * Resolve a provider API key from the process environment.
   * This is a fallback; canonical credential resolution belongs in the vault.
   */
  getEnvApiKey(provider: string): string | undefined;
}

/**
 * Current adapter: delegates directly to the pinned @mariozechner/pi-ai
 * globals. This is the only production module that imports those globals.
 */
export class PiProviderRuntime implements ProviderRuntime {
  complete(
    model: Model<any>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): Promise<ProviderRuntimeCompleteResult> {
    return completeSimple(model, context, options);
  }

  stream(
    model: Model<any>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): AsyncIterable<AssistantMessageEvent> {
    return streamSimple(model, context, options);
  }

  getProviders(): readonly KnownProvider[] {
    return getProviders();
  }

  getModels(provider: KnownProvider): readonly Model<Api>[] {
    return getModels(provider);
  }

  getEnvApiKey(provider: string): string | undefined {
    return getEnvApiKey(provider) ?? undefined;
  }
}
