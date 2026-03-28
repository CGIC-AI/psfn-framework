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
      runtime.approvalBoundary.gate({
        method: descriptor.name,
        handler: (params: unknown) => descriptor.handler(params as never, runtime),
        paramsSummary: descriptor.summary as (params: unknown) => Record<string, unknown>,
        approvalAction: descriptor.approvalAction,
        approvalScope: descriptor.approvalScope as (params: unknown) => string,
        approvalReason: descriptor.approvalReason as ((params: unknown) => string) | undefined,
      }),
    );
  }
}
