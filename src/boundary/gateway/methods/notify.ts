import type {
  NotifyNtfyParams,
  NotifyNtfyResult,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

const notifyDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'notify.ntfy',
    handler: async (params: NotifyNtfyParams, runtime): Promise<NotifyNtfyResult> => {
      return await runtime.sendNtfy(params);
    },
    summary: (p: NotifyNtfyParams) => ({
      topic: p.topic ? 'override' : 'default',
      hasTitle: !!p.title,
      priority: p.priority,
      messageLength: typeof p.message === 'string' ? p.message.length : 0,
    }),
  },
];

export function registerNotifyMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, notifyDescriptors);
}
