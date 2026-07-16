import {
  summarizeKubeSelfManagementParams,
  type KubeSelfManagementResponse,
} from '../../../system/lifecycle/kube-self-management.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

const descriptors: Array<AuditedMethodDescriptor<unknown, KubeSelfManagementResponse>> = [{
  name: 'kube.self_management',
  handler: async (params, runtime) => {
    if (!runtime.kubeSelfManagement) {
      throw new Error('Kubernetes self-management is not enabled in this gateway runtime.');
    }
    return await runtime.kubeSelfManagement.invoke({
      actor: runtime.authenticatedCompanionId() ?? '',
      params,
      approvals: {
        enqueue: (request, execute) => runtime.approvalBoundary.requestExplicitApproval({
          authenticatedCompanionId: runtime.authenticatedCompanionId(),
          request,
          execute,
        }),
      },
    });
  },
  summary: summarizeKubeSelfManagementParams,
}];

export function registerKubeSelfManagementMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, descriptors);
}
