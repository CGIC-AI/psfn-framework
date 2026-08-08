import type {
  GatewayCredentialPresenceParams,
  GatewayCredentialPresenceResult,
  RuntimeHealthParams,
  RuntimeHealthResult,
} from '../protocol.js';
import { defineAuditedMethod, type GatewayMethodRuntime } from './types.js';
import { gatewayMethodParamDecoders } from './params.js';
import { registerAuditedDescriptors } from './register.js';

const EMPTY_CREDENTIAL_PRESENCE: GatewayCredentialPresenceResult = {
  discordToken: false,
  apiKey: false,
  adminToken: false,
  openrouterApiKey: false,
  importProcessingLocalApiKey: false,
  falApiKey: false,
  telegramBotToken: false,
};

const runtimeHealthDescriptors = [
  defineAuditedMethod<RuntimeHealthParams, RuntimeHealthResult>({
    name: 'runtime.health',
    decode: gatewayMethodParamDecoders['runtime.health'],
    handler: async (_params, runtime) => {
      return runtime.getRuntimeHealth();
    },
    summary: () => ({}),
  }),
  defineAuditedMethod<GatewayCredentialPresenceParams, GatewayCredentialPresenceResult>({
    name: 'runtime.credential_presence',
    decode: gatewayMethodParamDecoders['runtime.credential_presence'],
    handler: async (_params, runtime) => runtime.getCredentialPresence?.() ?? EMPTY_CREDENTIAL_PRESENCE,
    summary: () => ({}),
  }),
];

export function registerRuntimeHealthMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, runtimeHealthDescriptors);
}
