import { createBuzzChannelPlugin } from '../buzz/plugin.js';
import { createMulticaChannelPlugin } from '../multica/plugin.js';
import { createChannelPluginRegistry } from './registry.js';
import type { ChannelPlugin, ChannelPluginRegistry } from './types.js';

function createBuiltinChannelPlugins(): ChannelPlugin[] {
  return [createMulticaChannelPlugin(), createBuzzChannelPlugin()];
}

export function createBuiltinChannelPluginRegistry(): ChannelPluginRegistry {
  return createChannelPluginRegistry(createBuiltinChannelPlugins());
}
