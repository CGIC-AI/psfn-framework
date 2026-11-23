import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveFleetScheduleStagger } from './proactive-lanes-wiring.js';

const STARTUP_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = dirname(STARTUP_DIR);

describe('proactive outreach lanes orchestration spine', () => {
  it('derives shared fleet schedule stagger only when fleet maintenance coordinator exists', () => {
    expect(resolveFleetScheduleStagger(undefined, 60_000)).toBeUndefined();
    expect(
      resolveFleetScheduleStagger(
        {
          manifestOrdinal: 1,
          fleetSize: 3,
          runSerialized: async (_job, fn) => fn(),
        } as Parameters<typeof resolveFleetScheduleStagger>[0],
        300_000,
      ),
    ).toEqual({
      manifestOrdinal: 1,
      fleetSize: 3,
      windowMs: 300_000,
    });
  });

  it('delegates proactive lanes, cognition intake, and API backend composition from agent/main.ts', () => {
    const mainSource = readFileSync(join(AGENT_DIR, 'main.ts'), 'utf8');
    expect(mainSource).toContain('wireAgentCognitionIntake({');
    expect(mainSource).toContain('wireAgentApiBackend({');
    expect(mainSource).toContain('wireProactiveOutreachLanes({');
    expect(mainSource).not.toContain('new ProactiveOutboundDispatcher(');
    expect(mainSource).not.toContain('createIntakeQuarantineStore(');
    expect(mainSource).not.toContain('new AgentApiBackend(');
  });
});
