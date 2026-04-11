import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  ExternalCommunicationRateLimiter,
  IdentityCoolingOffManager,
  LifecycleRestartSafeguard,
  getToolReversibility,
  resolveToolReversibility,
  tagToolWithReversibility,
} from './safeguards.js';

function mockTool(name: string): AgentTool<any> {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
}

describe('tool reversibility tagging', () => {
  it('classifies known irreversible tools', () => {
    expect(resolveToolReversibility('memory')).toBe('irreversible');
    expect(resolveToolReversibility('memory_write')).toBe('irreversible');
    expect(resolveToolReversibility('memory_redact')).toBe('irreversible');
    expect(resolveToolReversibility('memory_delete')).toBe('irreversible');
    expect(resolveToolReversibility('north_star')).toBe('irreversible');
    expect(resolveToolReversibility('scratchpad')).toBe('irreversible');
    expect(resolveToolReversibility('system')).toBe('irreversible');
    expect(resolveToolReversibility('repo')).toBe('irreversible');
    expect(resolveToolReversibility('repo_commit')).toBe('irreversible');
    expect(resolveToolReversibility('skill')).toBe('irreversible');
  });

  it('defaults unknown tools to reversible and supports explicit override', () => {
    const unknown = mockTool('custom_unknown_tool');
    tagToolWithReversibility(unknown);
    expect(getToolReversibility(unknown)).toBe('reversible');

    const explicit = mockTool('custom_explicit');
    tagToolWithReversibility(explicit, 'irreversible');
    expect(getToolReversibility(explicit)).toBe('irreversible');
  });
});

describe('IdentityCoolingOffManager', () => {
  it('stages, cools off, and commits base edits', () => {
    let now = 10_000;
    const manager = new IdentityCoolingOffManager({
      now: () => now,
      idFactory: () => 'stage-1',
      defaultCooldownMs: 5_000,
    });

    const stage = manager.stageBaseLayerEdit({
      layerId: 'layer-base',
      layerName: 'Base',
      previousContent: 'old',
      nextContent: 'new',
      requestedBy: 'agent',
      tier: 'apprentice',
    });
    expect(stage.id).toBe('stage-1');

    const cooling = manager.checkReady(stage.id);
    expect(cooling.status).toBe('cooling_off');
    expect(cooling.waitMs).toBe(5_000);

    now = 15_100;
    const ready = manager.checkReady(stage.id);
    expect(ready.status).toBe('ready');

    const committed = manager.markCommitted(stage.id);
    expect(committed.status).toBe('ready');
    expect(committed.stage?.status).toBe('committed');
  });

  it('cancels staged edits', () => {
    const manager = new IdentityCoolingOffManager({
      idFactory: () => 'stage-cancel',
      defaultCooldownMs: 5_000,
    });
    manager.stageBaseLayerEdit({
      layerId: 'layer-base',
      layerName: 'Base',
      previousContent: 'old',
      nextContent: 'new',
      requestedBy: 'agent',
      tier: 'nursery',
    });

    const cancelled = manager.cancel('stage-cancel');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.stage?.status).toBe('cancelled');
  });
});

describe('LifecycleRestartSafeguard', () => {
  it('requires reason and enforces cooldown and hourly cap', () => {
    let now = 0;
    const guard = new LifecycleRestartSafeguard({
      now: () => now,
      cooldownMs: 60_000,
      maxPerHour: 2,
    });

    const missingReason = guard.evaluate({
      toolName: 'self_restart',
      reason: '   ',
      tier: 'autonomous',
    });
    expect(missingReason.allowed).toBe(false);
    expect(missingReason.reason).toContain('reason is required');

    const first = guard.evaluate({
      toolName: 'self_restart',
      reason: 'apply config',
      tier: 'autonomous',
    });
    expect(first.allowed).toBe(true);

    const tooSoon = guard.evaluate({
      toolName: 'self_rebuild',
      reason: 'retry',
      tier: 'autonomous',
    });
    expect(tooSoon.allowed).toBe(false);
    expect(tooSoon.reason).toContain('cooldown');

    now = 61_000;
    const second = guard.evaluate({
      toolName: 'self_restart',
      reason: 'recover',
      tier: 'autonomous',
    });
    expect(second.allowed).toBe(true);

    now = 122_000;
    const hourlyLimited = guard.evaluate({
      toolName: 'self_restart',
      reason: 'third request',
      tier: 'autonomous',
    });
    expect(hourlyLimited.allowed).toBe(false);
    expect(hourlyLimited.reason).toContain('hourly limit');
  });
});

describe('ExternalCommunicationRateLimiter', () => {
  it('enforces per-channel hourly limits', () => {
    let now = 100;
    const limiter = new ExternalCommunicationRateLimiter({
      now: () => now,
      discordPerHour: 2,
      emailPerHour: 1,
    });

    expect(limiter.evaluate({ channel: 'discord', scope: 'alerts' }).allowed).toBe(true);
    expect(limiter.evaluate({ channel: 'discord', scope: 'alerts' }).allowed).toBe(true);

    const blockedDiscord = limiter.evaluate({ channel: 'discord', scope: 'alerts' });
    expect(blockedDiscord.allowed).toBe(false);
    expect(blockedDiscord.limit).toBe(2);

    expect(limiter.evaluate({ channel: 'email', scope: 'ops@team' }).allowed).toBe(true);
    const blockedEmail = limiter.evaluate({ channel: 'email', scope: 'ops@team' });
    expect(blockedEmail.allowed).toBe(false);
    expect(blockedEmail.limit).toBe(1);

    now += 60 * 60 * 1000 + 1;
    expect(limiter.evaluate({ channel: 'discord', scope: 'alerts' }).allowed).toBe(true);
  });
});
