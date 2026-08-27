import type { ChannelPlugin, ChannelPluginRegistry } from './types.js';

export function createChannelPluginRegistry(
  plugins: readonly ChannelPlugin[],
): ChannelPluginRegistry {
  const byId = new Map<string, ChannelPlugin>();
  for (const plugin of plugins) {
    const id = plugin.manifest.id.trim();
    if (!id) {
      throw new Error('Channel plugin manifest id must be non-empty');
    }
    if (byId.has(id)) {
      throw new Error(`Duplicate channel plugin registration "${id}"`);
    }
    byId.set(id, plugin);
  }
  return {
    get(id) {
      return byId.get(id);
    },
    has(id) {
      return byId.has(id);
    },
    list() {
      return [...byId.values()];
    },
  };
}
