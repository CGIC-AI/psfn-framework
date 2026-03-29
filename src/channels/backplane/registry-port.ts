import type { ChannelAdapterPort, ChannelPromptDock } from './types.js';

export interface ChannelPromptRegistryPort {
  get(id: string): ChannelPromptDock | undefined;
}

export interface ChannelAdapterRegistryPort extends ChannelPromptRegistryPort {
  get(id: string): ChannelAdapterPort | undefined;
  require<T extends ChannelAdapterPort = ChannelAdapterPort>(id: string): T;
  optional<T extends ChannelAdapterPort = ChannelAdapterPort>(id: string): T | null;
  has(id: string): boolean;
  readonly size: number;
  list(): readonly ChannelAdapterPort[];
}

export interface MutableChannelAdapterRegistryPort extends ChannelAdapterRegistryPort {
  register(adapter: ChannelAdapterPort): void;
  unregister(id: string): void;
  clear(): void;
}

export class ChannelAdapterRegistry implements MutableChannelAdapterRegistryPort {
  #adapters = new Map<string, ChannelAdapterPort>();

  get(id: string): ChannelAdapterPort | undefined {
    return this.#adapters.get(id);
  }

  require<T extends ChannelAdapterPort = ChannelAdapterPort>(id: string): T {
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw new Error(`Required channel adapter "${id}" was not loaded`);
    }
    return adapter as T;
  }

  optional<T extends ChannelAdapterPort = ChannelAdapterPort>(id: string): T | null {
    return (this.#adapters.get(id) as T | undefined) ?? null;
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  get size(): number {
    return this.#adapters.size;
  }

  list(): readonly ChannelAdapterPort[] {
    return [...this.#adapters.values()];
  }

  register(adapter: ChannelAdapterPort): void {
    this.#adapters.set(adapter.id, adapter);
  }

  unregister(id: string): void {
    this.#adapters.delete(id);
  }

  clear(): void {
    this.#adapters.clear();
  }
}
