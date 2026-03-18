import type { RuntimeHealthParams, RuntimeHealthResult } from '../protocol.js';
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

export function registerRuntimeHealthMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, runtimeHealthDescriptors);
}
