import { isRecord } from '../../shared/utils/types.js';
import type { ChannelPluginLoadedSection, ChannelPluginRegistry } from './types.js';

export const FIRST_CLASS_CHANNEL_CONFIG_KEYS: Record<string, true> = {
  discord: true,
  telegram: true,
  api: true,
  psfnAmica: true,
  companionUi: true,
  contextEnvelope: true,
};
export function parseChannelPluginSections(
  scopedRoot: Record<string, unknown>,
  registry: ChannelPluginRegistry,
): Record<string, ChannelPluginLoadedSection> {
  const loaded: Record<string, ChannelPluginLoadedSection> = {};
  for (const key of Object.keys(scopedRoot)) {
    if (FIRST_CLASS_CHANNEL_CONFIG_KEYS[key]) continue;
    const plugin = registry.get(key);
    if (!plugin) {
      throw new Error(`Unknown channel plugin "${key}"`);
    }
    const raw = scopedRoot[key];
    if (!isRecord(raw)) {
      throw new Error(`channels.json.${key} must be an object`);
    }
    const parsed = plugin.parseConfig(raw);
    loaded[key] = {
      id: plugin.manifest.id,
      ...parsed,
    };
  }
  return loaded;
}
