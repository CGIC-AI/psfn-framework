import type { ClarifyDeliverParams, ClarifyDeliverResult } from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

/**
 * vvf.5.2: gateway-side clarify delivery. Routes a runtime-owned
 * {@link ClarifyDeliverParams} to the interactive channel dock that renders the
 * choices and awaits the human's answer (Discord buttons / Telegram numbered
 * list). Discord uses the per-connection {@link GatewayMethodRuntime.discordAdapter}
 * dock so a companion can only render on its own bot; Telegram uses the
 * single-account dock. Fails closed when the requested channel is not wired.
 */
const clarifyDescriptors: Array<AuditedMethodDescriptor<ClarifyDeliverParams, ClarifyDeliverResult>> = [
  {
    name: 'clarify.deliver',
    handler: async (params: ClarifyDeliverParams, runtime: GatewayMethodRuntime) => {
      const dock = params.channel === 'discord' ? runtime.discordAdapter : runtime.telegramDock;
      const deliver = dock?.outbound.deliverClarification;
      if (!deliver) {
        throw new Error(`clarify is not available: ${params.channel} is not wired to present choices`);
      }
      return await deliver(params.clarification, params.target, params.timeoutMs, params.originatingUserId);
    },
    summary: (p: ClarifyDeliverParams) => ({
      channel: p.channel,
      target: p.target,
      clarificationId: p.clarification.id,
    }),
  },
];

export function registerClarifyMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, clarifyDescriptors);
}
