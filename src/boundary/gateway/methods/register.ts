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
  const runtimeWithCompatibility = runtime as Partial<GatewayMethodRuntime> & {
    gated?: <P, R>(
      method: string,
      handler: (params: P) => Promise<R>,
      paramsSummary?: (params: P) => Record<string, unknown>,
    ) => (params: P) => Promise<R>;
  };
  let gateMethod:
    | ((input: {
      method: string;
      handler: (params: unknown) => Promise<unknown>;
      paramsSummary?: (params: unknown) => Record<string, unknown>;
      approvalAction?: string;
      approvalScope?: (params: unknown) => string;
      approvalReason?: (params: unknown) => string;
    }) => (params: unknown) => Promise<unknown>)
    | undefined;
  if (runtimeWithCompatibility.approvalBoundary) {
    gateMethod = (input) => runtimeWithCompatibility.approvalBoundary!.gate({
      method: input.method,
      handler: input.handler,
      paramsSummary: input.paramsSummary ?? (() => ({})),
      approvalAction: input.approvalAction ?? input.method,
      approvalScope: input.approvalScope ?? (() => input.method),
      ...(input.approvalReason ? { approvalReason: input.approvalReason } : {}),
    });
  } else if (runtimeWithCompatibility.gated) {
    gateMethod = ({ method, handler }) => runtimeWithCompatibility.gated!(method, handler);
  }
  if (gateMethod === undefined) {
    throw new Error('Gateway method runtime is missing approvalBoundary.gate');
  }

  for (const descriptor of descriptors) {
    runtime.target.addMethod(
      descriptor.name,
      gateMethod({
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
