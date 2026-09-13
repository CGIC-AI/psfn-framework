import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { AdminSubsystemHealthDataService } from './subsystem-health-service.js';
import { withCompanionSystemMonitorEvidence } from './companion-system-monitor.js';
const ID = '11111111-1111-4111-8111-111111111111';
const configuration = () => ({ companionId: ID, freeTimeEnabled: true, socialDesireEnabled: false,
  weightedThoughtOutreachEnabled: true, emosimProactivityMode: 'on' as const });
describe('companion system monitor evidence', () => {
  it('keeps durable read failure separate from scheduler and source observations', async () => {
    const bus = new EventBus();
    const service = withCompanionSystemMonitorEvidence(new AdminSubsystemHealthDataService({
      eventBus: bus, now: () => 100, scheduler: { getFullData: () => ({ tasks: [
        { id: 'check', name: 'Check', type: 'every', state: 'idle', intervalMs: 50, lastRunAt: 80, lastFinishedAt: 90, lastOutcome: 'succeeded' },
      ] }) },
    }), { configuration, readProactive: async () => { throw new Error('PRIVATE DATABASE DETAILS'); } });
    const snapshot = await service.getSnapshot();
    expect(snapshot.monitor).toMatchObject({ companionId: ID, proactive: { status: 'error' }, socialDesireEnabled: false });
    expect(snapshot.lanes.find(lane => lane.id === 'scheduler:check')).toMatchObject({ lastSuccessAt: 90 });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });
  it.each([
    ['companion_rested', 'ok'], ['chooser_timeout', 'failed'], ['chooser_error', 'failed'], ['chooser_disabled', 'skipped'],
  ])('reports free-time %s as %s without exporting session content', async (restReason, status) => {
    const bus = new EventBus();
    const service = new AdminSubsystemHealthDataService({ eventBus: bus, now: () => 100 });
    await bus.emit('scheduler.free_time.block', {
      lane: 'idle', channelId: 'PRIVATE CHANNEL', turnsUsed: 0, activity: false,
      endReason: 'rested', restReason, spentChargeUnits: 0, maxChargeUnits: 10, maxTurns: 1,
      startedAtMs: 80, endedAtMs: 90, returnSurfaced: false, timestamp: 90,
    });
    const snapshot = await service.getSnapshot();
    expect(snapshot.lanes.find(lane => lane.id === 'free_time')).toMatchObject({ status,
      counts: { startedAtMs: 80, endedAtMs: 90, turnsUsed: 0 } });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE CHANNEL');
  });
});
