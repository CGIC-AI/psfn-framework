import type {
  GatewayCredentialPresenceParams,
  GatewayCredentialPresenceResult,
  RuntimeHealthParams,
  RuntimeHealthResult,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

const runtimeHealthDescriptors: Array<AuditedMethodDescriptor<RuntimeHealthParams, RuntimeHealthResult>> = [
  {
    name: 'runtime.health',
    handler: async (_params: RuntimeHealthParams, runtime: GatewayMethodRuntime): Promise<RuntimeHealthResult> => {
      return runtime.getRuntimeHealth();
    },
    summary: () => ({}),
  },
];

const EMPTY_CREDENTIAL_PRESENCE: GatewayCredentialPresenceResult = {
  discordToken: false,
  apiKey: false,
  adminToken: false,
  openrouterApiKey: false,
  litellmBaseUrl: false,
  litellmApiKey: false,
  importProcessingLocalApiKey: false,
  falApiKey: false,
  telegramBotToken: false,
};

export function registerRuntimeHealthMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, runtimeHealthDescriptors);
  runtime.target.addMethod(
    'runtime.credential_presence',
    (_params: GatewayCredentialPresenceParams): GatewayCredentialPresenceResult =>
      runtime.getCredentialPresence?.() ?? EMPTY_CREDENTIAL_PRESENCE,
  );
}
