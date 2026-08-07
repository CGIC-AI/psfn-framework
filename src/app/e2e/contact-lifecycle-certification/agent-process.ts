import { GatewayClient } from '../../../boundary/gateway/client.js';
import type { GatewayRpcEndpoint } from '../../../boundary/gateway/transport.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { parseContactAuthorityLifecycleRequest } from '../../../shared/contracts/contact-authority-lifecycle.js';

interface Command {
  id: number;
  type: 'execute' | 'shutdown';
  request?: unknown;
}

function reply(value: Record<string, unknown>): void {
  if (!process.send) throw new Error('Contact lifecycle certification agent requires IPC');
  process.send(value);
}

async function main(): Promise<void> {
  const rawEndpoint = process.env.CONTACT_LIFECYCLE_CERTIFICATION_ENDPOINT;
  const companionId = process.env.COMPANION_ID;
  const authToken = process.env.GATEWAY_COMPANION_AUTH_TOKEN;
  if (!rawEndpoint || !companionId || !authToken) {
    throw new Error('Contact lifecycle certification agent environment is incomplete');
  }
  let endpoint: GatewayRpcEndpoint;
  try {
    endpoint = JSON.parse(rawEndpoint) as GatewayRpcEndpoint;
  } catch (error) {
    throw new Error('Contact lifecycle certification gateway endpoint is invalid JSON', {
      cause: error,
    });
  }
  const gateway = await GatewayClient.connectEndpoint(endpoint, 8, {
    companionId: createCompanionId(companionId),
    companionAuthToken: authToken,
    keepaliveIntervalMs: 60_000,
  });
  await gateway.identifyAsAgent();
  await gateway.declareRuntimeReady();
  reply({ type: 'ready', ok: true, companionId });

  process.on('message', (raw: Command) => {
    void (async () => {
      try {
        if (raw.type === 'shutdown') {
          gateway.destroy();
          reply({ id: raw.id, ok: true });
          process.disconnect();
          return;
        }
        const request = parseContactAuthorityLifecycleRequest(raw.request);
        const result = await gateway.executeContactLifecycle(request);
        reply({ id: raw.id, ok: true, result });
      } catch (error) {
        reply({
          id: raw.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}

main().catch((error) => {
  reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
