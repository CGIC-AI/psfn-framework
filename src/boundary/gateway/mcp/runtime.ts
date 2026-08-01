import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import type { McpServersConfig } from '../../../system/config/mcp-servers-config.js';
import type { CredentialVaultPort } from '../../custody/credential-vault.js';
import {
  createMcpGatewayBroker,
  type McpGatewayBroker,
  type McpProtocolClientFactory,
} from './broker.js';
import { createMcpCogSecScreeningPort } from './cogsec-screening.js';
import { createMcpSdkClientFactory } from './sdk-client.js';

export interface McpGatewayRuntime {
  broker: McpGatewayBroker | null;
  enabledServerCount: number;
}

export function composeMcpGatewayRuntime(input: {
  config: McpServersConfig;
  credentialVault?: CredentialVaultPort;
  screeningFor: (companionId: string) => IntakeScreeningService | null;
  clientFactory?: McpProtocolClientFactory;
}): McpGatewayRuntime {
  const enabledServers = input.config.servers.filter(server => server.enabled);
  if (enabledServers.length === 0) {
    return { broker: null, enabledServerCount: 0 };
  }
  if (!input.credentialVault) {
    throw new Error('Enabled MCP servers require the gateway credential vault');
  }
  const companionIds = new Set(enabledServers.flatMap(server => server.allowedCompanionIds));
  for (const companionId of companionIds) {
    if (!input.screeningFor(companionId)) {
      throw new Error(
        `Enabled MCP servers require CogSec screening for allowed companion '${companionId}'`,
      );
    }
  }

  const screening = createMcpCogSecScreeningPort(input.screeningFor);
  const clientFactory = input.clientFactory ?? createMcpSdkClientFactory({
    credentialVault: input.credentialVault,
  });
  return {
    broker: createMcpGatewayBroker({
      config: input.config,
      clientFactory,
      screening,
    }),
    enabledServerCount: enabledServers.length,
  };
}
