import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CogSecEventStore } from '../events.js';
import { createOrdinaryIntakeSinkDenialRecorder } from './sink-gate-incidents.js';

describe('ordinary intake sink denial incidents (bead 62fv0)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function storePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-sink-denial-incident-'));
    dirs.push(dir);
    return join(dir, 'cogsec-events.json');
  }

  function denial() {
    return {
      decision: {
        sink: 'memory_write' as const,
        allowed: false,
        verdict: 'deny' as const,
        mode: 'enforce' as const,
        reason: "envelope opaque-1 state 'quarantined' is not sink-consumable",
        unscreened: false,
        deniedEnvelopeIds: ['opaque-1'],
      },
      context: {
        correlationId: 'cogsec_sinkdenial_0123456789abcdef0123456789abcdef01234567',
        sourceChannelId: 'discord:room-1',
        logicalSessionId: 'session-1',
      },
    };
  }

  it.each([
    { error: new Error('transport offline'), status: 'failed' as const },
    {
      error: new Error('Operator alerting has zero configured sinks; alerts cannot leave the runtime.'),
      status: 'unconfigured' as const,
    },
  ])('records $status notification evidence without persisting the transport error', async ({ error, status }) => {
    const path = storePath();
    const notify = vi.fn().mockRejectedValue(error);
    const record = createOrdinaryIntakeSinkDenialRecorder({
      cogSecEvents: () => new CogSecEventStore(path),
      notifier: { notify },
      companionName: 'Test Companion',
    });

    const evidence = record(denial());

    await expect(evidence.notification).resolves.toEqual({ status });
    const [event] = new CogSecEventStore(path).listEvents();
    expect(event.safeAgentSummary).toContain(`Operator alert delivery: ${status}.`);
    expect(JSON.stringify(event)).not.toContain(error.message);
    expect(JSON.stringify(event)).not.toContain('secret payload');
  });

  it('rejects a callback invocation that is not an enforce-mode ordinary denial', () => {
    const record = createOrdinaryIntakeSinkDenialRecorder({
      cogSecEvents: () => new CogSecEventStore(storePath()),
      notifier: { notify: vi.fn() },
      companionName: 'Test Companion',
    });

    expect(() => record({
      ...denial(),
      decision: { ...denial().decision, mode: 'shadow', allowed: true },
    })).toThrow(/enforce-mode denial/);
  });
});
