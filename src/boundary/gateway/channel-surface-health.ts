// Projects a contained channel-surface failure (bead psfn-framework-6cs5j) into
// the content-free health plane. The error text stays in the gateway log; the
// stream carries the code, a digest of the surface id, and counts only.
//
//   * `channel_surface_failed` — one observation per failed attempt or runtime
//     fault. The background-failure detector turns repeats inside its window
//     into one episode that closes when the channel recovers.
//   * `channel_surface_disabled` — the channel refused to run and will not be
//     retried. A standalone incident keyed on a STABLE per-surface correlation
//     id, so a crash-looping gateway stays one incident per disabled channel.

import type { ChannelSurfaceFailure } from '../../channels/backplane/channel-isolation.js';
import {
  emitHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  stableHealthConditionCorrelationId,
  type HealthEventOwner,
  type HealthEventPublisher,
} from '../../shared/contracts/health-event.js';

export function createChannelSurfaceHealthReporter(
  publisher: HealthEventPublisher,
  now: () => number = Date.now,
): (failure: ChannelSurfaceFailure) => Promise<void> {
  return async (failure) => {
    const owner: HealthEventOwner = failure.companionId
      ? { kind: 'companion', companionId: failure.companionId }
      : { kind: 'system' };
    const subjectHash = hashHealthEventSubject(`channel:${failure.surfaceId}`);
    const code = failure.terminal ? 'channel_surface_disabled' : 'channel_surface_failed';
    await emitHealthEvent(publisher, {
      owner,
      severity: failure.terminal ? 'critical' : 'degraded',
      code,
      ...(failure.terminal
        ? { correlationId: stableHealthConditionCorrelationId(code, owner, subjectHash) }
        : {}),
      provenance: {
        process: 'gateway',
        component: 'channels',
        observerId: processObserverId(),
        subjectHash,
      },
      observedAtMs: now(),
      evidence: { attemptCount: failure.attempt, terminal: failure.terminal },
    });
  };
}
