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
    summary: (p: NotifyNtfyParams) => {
      const rawSender = (p as { sender?: unknown }).sender;
      const sender = typeof rawSender === 'object' && rawSender !== null
        ? rawSender as { kind?: unknown; provenance?: unknown }
        : {};
      return {
        topic: p.topic ? 'override' : 'default',
        hasTitle: !!p.title,
        priority: p.priority,
        senderKind: typeof sender.kind === 'string' ? sender.kind : 'invalid',
        senderProvenance: typeof sender.provenance === 'string' ? sender.provenance : 'invalid',
        messageLength: typeof p.message === 'string' ? p.message.length : 0,
      };
    },
  },
];

export function registerNotifyMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, notifyDescriptors);
}
