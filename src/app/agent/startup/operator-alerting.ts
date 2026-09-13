import type { GatewayClient } from '../../../boundary/gateway/client.js';
import type { RuntimeHealthResult } from '../../../boundary/gateway/protocol.js';
import type { OperatorAlertSinkConfiguration } from '../../../shared/contracts/operator-alerting.js';

/** Notification credentials and sink ownership stay in the gateway. */
export async function loadGatewayOperatorAlerting(
  gateway: Pick<GatewayClient, 'runtimeHealth'>,
): Promise<OperatorAlertSinkConfiguration> {
  const snapshot: Partial<RuntimeHealthResult> = await gateway.runtimeHealth();
  if (!snapshot.operatorAlerting) {
    throw new Error('Gateway runtime.health did not provide its operator alert sink configuration');
  }
  return snapshot.operatorAlerting;
}
