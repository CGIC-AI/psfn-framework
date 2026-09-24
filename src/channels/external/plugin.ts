import type { ChannelPluginHost } from '../plugins/host.js';
import type { ChannelPlugin } from '../plugins/types.js';
import { ExternalChannelAdapter } from './adapter.js';
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
      return {
        adapter: new ExternalChannelAdapter({
          config,
          token,
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
