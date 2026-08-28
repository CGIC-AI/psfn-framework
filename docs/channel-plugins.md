# Gateway channel plugins

Installable gateway channels register through `ChannelPluginHost`. Discord,
Telegram, the API surface, and Satellite Hub stay first-class; a new *text*
channel should not add branches to gateway composition or lifecycle.

Current built-in plugins are [Multica](multica-channel.md) and
[Buzz](buzz-channel.md).

Live owner files, environment values, and secrets stay outside this repository.
`channels.json` may only hold credential *references*.

## Register one plugin

Add the plugin to `src/channels/plugins/builtin.ts`. That is the only registry
location. Do not edit `src/boundary/gateway/channel-surfaces.ts` or
`src/app/gateway/main.ts` for a conforming channel.

```ts
import type { ChannelPlugin } from '../plugins/types.js';

export function createExampleChannelPlugin(): ChannelPlugin<{ enabled: boolean }> {
  return {
    manifest: { id: 'example', label: 'Example' },
    parseConfig(raw) {
      // validate plugin-owned keys; reject unknown keys and inline secrets
      return {
        enabled: true,
        credentials: [{
          id: 'token',
          reference: { kind: 'env', envName: 'EXAMPLE_CHANNEL_TOKEN' },
          description: 'Example channel token',
        }],
        config: { enabled: true },
      };
    },
    create({ config, secrets, context }) {
      // `secrets.token` is resolved by the gateway vault for this plugin only
      void config;
      void secrets;
      void context;
      throw new Error('replace with adapter construction');
    },
  };
}
```

Owner-file section, same id as the manifest:

```json
{
  "example": {
    "enabled": true,
    "tokenRef": { "kind": "env", "envName": "EXAMPLE_CHANNEL_TOKEN" }
  }
}
```

The host validates config, resolves declared references through
`CredentialVaultPort`, constructs, then owns initialize/start/stop. Missing
credentials, unknown plugin ids, invalid config, duplicate registrations, and
lifecycle failures reject without fallback.
