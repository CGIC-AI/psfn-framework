// ── Operator-alert sink adapter for the human escalation plane (bznbn) ──
//
// The `operator_alert` sink is not a new delivery path. It is a thin adapter
// over the seam that already exists: `GatewayOperatorAlertDispatcher.dispatch`
// in the gateway process and `GatewayClient.notifyOperator` in the agent,
// both of which structurally satisfy {@link OperatorIncidentAlertSink}. The
// dispatcher's fan-out, per-sink failure containment, and unconfigured-state
// reporting are unchanged and unwrapped; this file only translates their
// results into the plane's outcome vocabulary.
//
// The dispatcher is resolved PER DELIVERY rather than captured once, for the
// same startup-ordering reason the incident alert path already resolves it
// lazily: the gateway's first escalation — `operator_alert_sinks_unconfigured`
// — is raised during startup, before the RPC server that owns the dispatcher
// exists. Saying `no_sink` at that moment is the literal truth, and the durable
// ledger row the plane wrote is what makes it visible anyway.

import type {
  HumanEscalationDeliveryOutcome,
  HumanEscalationRecord,
} from '../../shared/escalation/contracts.js';
import type { HumanEscalationSink } from '../../shared/escalation/control-plane.js';
import type { OperatorIncidentAlertSink } from './incident-alert-delivery.js';
import type { NotifyNtfyParams } from './protocol.js';

export function createOperatorAlertEscalationSink(options: {
  resolveDispatcher: () => OperatorIncidentAlertSink | null;
}): HumanEscalationSink<NotifyNtfyParams> {
  return {
    id: 'operator_alert',
    async deliver(
      notice: NotifyNtfyParams,
      _record: HumanEscalationRecord,
    ): Promise<HumanEscalationDeliveryOutcome> {
      const dispatcher = options.resolveDispatcher();
      if (!dispatcher) return 'no_sink';
      // A throw here reaches the control plane, which contains it as
      // `delivery_failed` and records the attempt. The dispatcher only throws
      // when every configured sink failed, which is itself operator-visible
      // news the incident path logs with its own incident context.
      const result = await dispatcher.dispatch(notice);
      return result.outcome === 'unconfigured' ? 'unconfigured' : 'delivered';
    },
  };
}
