import { createMulticaChannelPlugin } from '../multica/plugin.js';
import { createChannelPluginRegistry } from './registry.js';
import type { ChannelPlugin, ChannelPluginRegistry } from './types.js';

function createBuiltinChannelPlugins(): ChannelPlugin[] {
  return [createMulticaChannelPlugin()];
}

export function createBuiltinChannelPluginRegistry(): ChannelPluginRegistry {
  return createChannelPluginRegistry(createBuiltinChannelPlugins());
}
