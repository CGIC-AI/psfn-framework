import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wireSkillsRuntime } from './runtime-wiring.js';
import type { IntakeSinkGate } from '../../core/cogsec/intake/sink-gates.js';

describe('skills runtime wiring', () => {
  it('attaches skills runtime and registers the unified skill tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-wire-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'config');

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'skills.seed.json'), JSON.stringify({
      enabled: true,
      directories: ['skills'],
      extraDirectories: [],
      maxLoadedSkills: 32,
      maxSkillChars: 24_000,
      disabledSkills: [],
    }, null, 2));

    const registerTool = vi.fn();
    const target = {
      skillsRuntime: null,
      registerTool,
    };

    try {
      const runtime = wireSkillsRuntime(target, {
        dataDir,
        seedDir,
        repoRoot: root,
      }, {
        getCapabilityTier: () => 'autonomous',
      });

      expect(runtime).toBe(target.skillsRuntime);
      expect(registerTool).toHaveBeenCalledTimes(1);
      expect(registerTool.mock.calls[0]?.[0]?.name).toBe('skill');
      expect(registerTool.mock.calls[0]?.[1]).toBe('core');
      // Parity with peer self-mod tools: explicit capability annotation.
      expect(registerTool.mock.calls[0]?.[0]?.requiredCapability).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('threads the canonical intake dependencies into managed skill writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-wire-intake-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const evaluate = vi.fn(() => ({
      sink: 'skill_write' as const,
      allowed: false,
      verdict: 'deny' as const,
      mode: 'enforce' as const,
      reason: 'unscreened content denied',
      unscreened: true,
      deniedEnvelopeIds: [],
    }));
    const gate: IntakeSinkGate = {
      mode: 'enforce',
      evaluate,
      assessEgressTrifecta: vi.fn(),
    };
    const registerTool = vi.fn();
    const target = {
      skillsRuntime: null,
      registerTool,
    };

    try {
      wireSkillsRuntime(target, {
        dataDir,
        repoRoot: root,
      }, {
        getCapabilityTier: () => 'autonomous',
      }, {
        getIntakeSinkGate: () => gate,
        getIntakeScreening: () => null,
        getActiveTurnIntakeEnvelopes: () => [],
      });

      const tool = registerTool.mock.calls[0]?.[0];
      await tool.execute('skill-write', {
        action: 'create',
        name: 'blocked',
        category: 'ops',
        content: '# Blocked\n\nNo screened envelope exists.',
      });
      expect(evaluate).toHaveBeenCalledWith('skill_write', [], {
        tool: 'skill',
        action: 'create',
        screening: 'unavailable',
      }, {
        attemptRef: 'skill-write',
        correlationRef: 'unrouted:create',
      });
      expect(target.skillsRuntime?.getStore().list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
