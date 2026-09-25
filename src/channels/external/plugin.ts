import type { ChannelPluginHost } from '../plugins/host.js';
import type { ChannelPlugin } from '../plugins/types.js';
import { ExternalChannelAdapter } from './adapter.js';
import { externalObserverIdentity } from './message-addressing.js';
import {
  EXTERNAL_CHANNEL_PLUGIN_ID,
  EXTERNAL_CHANNEL_TOKEN_CREDENTIAL_ID,
  parseExternalChannelSection,
  type ExternalChannelInstanceConfig,
} from './config.js';

/**
 * The generic external channel plugin: adding a messaging system (SMS,
 * WhatsApp, ...) needs only an out-of-process bridge plus one
 * `channels.json.external.adapters[]` entry — no in-tree channel code.
 */
export function createExternalChannelPlugin(): ChannelPlugin<ExternalChannelInstanceConfig | null> {
  return {
    manifest: { id: EXTERNAL_CHANNEL_PLUGIN_ID, label: 'External channel adapters' },
    parseConfig: raw => parseExternalChannelSection(raw),
    create: ({ config, secrets, context, reportRuntimeFailure }) => {
      if (!config) {
        throw new Error('External channel adapters run only as declared adapter instances');
      }
      const token = secrets[EXTERNAL_CHANNEL_TOKEN_CREDENTIAL_ID];
      if (!token) {
        throw new Error(`External channel adapter "${config.instanceId}" has no bearer token`);
      }
      // The companion's own account in this adapter's rooms. Its label comes
      // from companions.json displayName; without one the companion id names
      // it (a display label only, never an authority) and the operator is told.
      if (!context.companionDisplayName) {
        context.log.warn(
          'External channel adapter companion has no companions.json displayName; '
          + 'group-room addressing names the companion by its id',
          { instanceId: config.instanceId, companionId: config.companionId },
        );
      }
      return {
        adapter: new ExternalChannelAdapter({
          config,
          token,
          observer: externalObserverIdentity({
            instanceId: config.instanceId,
            displayName: context.companionDisplayName ?? config.companionId,
          }),
          intakeScreening: context.intakeScreening,
          log: context.log,
          reportRuntimeFailure,
        }),
      };
    },
  };
}

/** Every loaded external adapter, for the API server to serve. */
export function listExternalChannelAdapters(
  host: Pick<ChannelPluginHost, 'list'>,
): ExternalChannelAdapter[] {
  return host.list().flatMap(entry => (
    entry.instance.adapter instanceof ExternalChannelAdapter ? [entry.instance.adapter] : []
  ));
}
