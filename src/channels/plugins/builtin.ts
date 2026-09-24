import { createChannelPluginRegistry } from './registry.js';
import type { ChannelPlugin, ChannelPluginRegistry } from './types.js';

function createBuiltinChannelPlugins(): ChannelPlugin[] {
  return [];
}

export function createBuiltinChannelPluginRegistry(): ChannelPluginRegistry {
  return createChannelPluginRegistry(createBuiltinChannelPlugins());
}
