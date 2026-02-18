import type {
  AuditedMethodDescriptor,
  GatewayMethodRuntime,
  GatedMethodDescriptor,
} from './types.js';

export function registerAuditedDescriptors(
  runtime: GatewayMethodRuntime,
  descriptors: ReadonlyArray<AuditedMethodDescriptor<any, unknown>>,
): void {
  for (const descriptor of descriptors) {
    runtime.target.addMethod(
      descriptor.name,
      runtime.audited(
        descriptor.name,
        (params: unknown) => descriptor.handler(params as never, runtime),
        descriptor.summary as ((params: unknown) => Record<string, unknown>) | undefined,
      ),
    );
  }
}

export function registerGatedDescriptors(
  runtime: GatewayMethodRuntime,
  descriptors: ReadonlyArray<GatedMethodDescriptor<any, unknown>>,
): void {
  for (const descriptor of descriptors) {
    runtime.target.addMethod(
      descriptor.name,
      runtime.gated(
        descriptor.name,
        (params: unknown) => descriptor.handler(params as never, runtime),
        descriptor.summary as (params: unknown) => Record<string, unknown>,
        descriptor.approvalAction,
        descriptor.approvalScope as (params: unknown) => string,
      ),
    );
  }
}
