import type {
  NotifyNtfyParams,
  NotifyNtfyResult,
  OperatorAlertResult,
} from '../protocol.js';
import type { GatewayMethodRuntime } from './types.js';
import { defineAuditedMethod } from './types.js';
import { gatewayMethodParamDecoders } from './params.js';
import { registerAuditedDescriptors } from './register.js';

const notifyDescriptors = [
  defineAuditedMethod<NotifyNtfyParams, NotifyNtfyResult>({
    name: 'notify.ntfy',
    decode: gatewayMethodParamDecoders['notify.ntfy'],
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
  }),
  defineAuditedMethod<NotifyNtfyParams, OperatorAlertResult>({
    name: 'notify.operator',
    decode: gatewayMethodParamDecoders['notify.operator'],
    handler: async (params: NotifyNtfyParams, runtime): Promise<OperatorAlertResult> => {
      return await runtime.sendOperatorAlert(params);
    },
    summary: (p: NotifyNtfyParams) => {
      const rawSender = (p as { sender?: unknown }).sender;
      const sender = typeof rawSender === 'object' && rawSender !== null
        ? rawSender as { kind?: unknown; provenance?: unknown }
        : {};
      return {
        hasTitle: Boolean(p.title),
        priority: p.priority,
        senderKind: typeof sender.kind === 'string' ? sender.kind : 'invalid',
        senderProvenance: typeof sender.provenance === 'string' ? sender.provenance : 'invalid',
        messageLength: typeof p.message === 'string' ? p.message.length : 0,
      };
    },
  }),
];

export function registerNotifyMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, notifyDescriptors);
}
