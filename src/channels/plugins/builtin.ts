import { createExternalChannelPlugin } from '../external/plugin.js';
import { createChannelPluginRegistry } from './registry.js';
import type { ChannelPlugin, ChannelPluginRegistry } from './types.js';

function createBuiltinChannelPlugins(): ChannelPlugin[] {
  return [createExternalChannelPlugin()];
}

export function createBuiltinChannelPluginRegistry(): ChannelPluginRegistry {
  return createChannelPluginRegistry(createBuiltinChannelPlugins());
}
