/**
 * Channel plugin ids removed from the framework (psfn-framework-lef2o). Their
 * channels.json sections are stripped only by the owner-file migration run by
 * `migrate-required-settings-blocks`; the runtime loader keeps rejecting them
 * so a stale owner file fails closed with an actionable message.
 */
export const RETIRED_CHANNEL_PLUGIN_IDS: readonly string[] = ['buzz', 'multica'];

export function isRetiredChannelPluginId(id: string): boolean {
  return RETIRED_CHANNEL_PLUGIN_IDS.includes(id);
}
