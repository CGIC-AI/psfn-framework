import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(join(SRC_DIR, fileName), 'utf-8');
}

describe('maintenance interval wiring', () => {
  it('uses runtime config interval in SubstrateRuntime scheduler wiring', () => {
    const runtimeSource = readSource('runtime.ts');
    const salienceDecayTask = /id:\s*'salience-decay'[\s\S]*?handler:\s*\(\)\s*=>\s*this\.salienceDecay\.run\(\)/m.exec(runtimeSource)?.[0] ?? runtimeSource;
    expect(salienceDecayTask).toContain('intervalMs: this.config.maintenanceIntervalMs');
    expect(salienceDecayTask).not.toContain('intervalMs: MEMORY_CONFIG.maintenanceIntervalMs');
  });

  it('uses runtime config interval in agent-main scheduler wiring', () => {
    const agentMainSource = readSource('agent-main.ts');
    const salienceDecayTask = /id:\s*'salience-decay'[\s\S]*?handler:\s*\(\)\s*=>\s*salienceDecay\.run\(\)/m.exec(agentMainSource)?.[0] ?? agentMainSource;
    expect(salienceDecayTask).toContain('intervalMs: config.maintenanceIntervalMs');
    expect(salienceDecayTask).not.toContain('intervalMs: MEMORY_CONFIG.maintenanceIntervalMs');
  });

  it('wires periodic compression guideline review through runtime scheduler', () => {
    const runtimeSource = readSource('runtime.ts');
    const guidelineTask = /id:\s*COMPACTION_GUIDELINE_REVIEW_TASK_ID[\s\S]*?runPeriodicCompressionGuidelineUpdate\(this\.llmClient\)/m.exec(runtimeSource)?.[0] ?? runtimeSource;
    expect(guidelineTask).toContain('intervalMs: this.config.maintenanceIntervalMs');
    expect(guidelineTask).toContain('runPeriodicCompressionGuidelineUpdate(this.llmClient)');
  });

  it('wires post-turn compression failure capture in runtime and agent-main', () => {
    const runtimeSource = readSource('runtime.ts');
    expect(runtimeSource).toContain("this.eventBus.on('agent.turn.end'");
    expect(runtimeSource).toContain('recordCompressionFailureFromResponse');

    const agentMainSource = readSource('agent-main.ts');
    expect(agentMainSource).toContain("eventBus.on('agent.turn.end'");
    expect(agentMainSource).toContain('recordCompressionFailureFromResponse');
  });
});
