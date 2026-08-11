import { describe, expect, it } from 'vitest';
import { GatewayRuntimeHealthTracker } from './runtime-health.js';

describe('GatewayRuntimeHealthTracker approval notifications', () => {
  it('surfaces an unreachable approval notification sink to Garden health', () => {
    const tracker = new GatewayRuntimeHealthTracker({
      ntfyConfigured: false,
      approvalNotificationConfigured: false,
      vaultEnabled: false,
      vaultAllowActions: [],
      vaultOpsConfigured: false,
    });

    tracker.recordApprovalNotificationFailure(new Error('no reachable operator notification sink'));

    expect(tracker.getSnapshot({ total: 1, registering: 0, ready: 1, degraded: 0, offline: 0 }).services)
      .toContainEqual(expect.objectContaining({
        serviceId: 'approval_notifications',
        status: 'unavailable',
        lastFailure: expect.objectContaining({
          message: 'no reachable operator notification sink',
          scope: 'approval.notification',
        }),
      }));
  });

  it('clears a notification failure after a later successful delivery', () => {
    const tracker = new GatewayRuntimeHealthTracker({
      ntfyConfigured: true,
      approvalNotificationConfigured: true,
      vaultEnabled: false,
      vaultAllowActions: [],
      vaultOpsConfigured: false,
    });

    tracker.recordApprovalNotificationFailure(new Error('temporary delivery failure'));
    tracker.recordApprovalNotificationSuccess();

    expect(tracker.getSnapshot({ total: 1, registering: 0, ready: 1, degraded: 0, offline: 0 }).services)
      .toContainEqual(expect.objectContaining({
        serviceId: 'approval_notifications',
        status: 'healthy',
      }));
  });
});
