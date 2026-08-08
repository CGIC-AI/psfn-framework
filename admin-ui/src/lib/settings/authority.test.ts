import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AdminSettingsData, SettingsContractData } from '../types/index.ts';
import {
  resolveBudgetContextWindowAuthority,
  resolveSettingAuthority,
} from './authority.ts';

const baseData = {
  config: {
    capabilityTier: 'apprentice',
  },
  env: {},
  editors: {
    models: {
      modelRoleAssignments: {
        chat: 'chat-primary',
      },
      modelCatalog: {
        'chat-primary': {
          contextWindow: 200000,
        },
      },
      modelRoster: {},
    },
    skills: {},
    scheduler: {
      backgroundMaintenance: {
        intervalMs: 120000,
      },
    },
    trustPolicy: {},
    capabilities: {
      tier: 'custom',
      customTokens: ['identity.read', 'memory.read', 'memory.write', 'audit.read'],
    },
  },
  voiceProviders: {
    stt: [],
    tts: [],
  },
  effectiveBackgroundMaintenance: {
    ownerFile: 'scheduler.json',
    effectiveIntervalMs: 3600000,
    onDiskIntervalMs: 120000,
    restartRequired: true,
  },
} as unknown as AdminSettingsData;

const baseSchema = {
  schemaVersion: 1,
  subsystems: {},
  fields: {
    backgroundMaintenanceIntervalMs: {
      key: 'backgroundMaintenanceIntervalMs',
      ownerSubsystem: 'scheduler',
      ownerFile: 'scheduler.json',
      type: 'integer',
    },
    capabilityTier: {
      key: 'capabilityTier',
      ownerSubsystem: 'capabilities',
      ownerFile: 'capability-tier.json',
      type: 'enum',
    },
    customTokens: {
      key: 'customTokens',
      ownerSubsystem: 'capabilities',
      ownerFile: 'capability-tier.json',
      type: 'string_array',
    },
    sessionHistoryBudgetPct: {
      key: 'sessionHistoryBudgetPct',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'integer',
    },
  },
} as unknown as SettingsContractData;

test('bundled background-maintenance interval authority points at scheduler ownership', () => {
  const info = resolveSettingAuthority(baseData, baseSchema, 'backgroundMaintenanceIntervalMs');
  assert.equal(info.sourceLabel, 'scheduler.json');
  assert.equal(info.effectiveValue, 'Live: 3,600,000 ms · on disk: 120,000 ms');
  assert.match(info.detail, /scheduler\.json > backgroundMaintenance\.intervalMs/);
  assert.match(info.detail, /unchanged until restart/);
  assert.match(info.precedence ?? '', /Restart required/);
});

test('custom capability tokens authority shows dormant/active precedence', () => {
  const info = resolveSettingAuthority(baseData, baseSchema, 'customTokens');
  assert.equal(info.sourceLabel, 'capability-tier.json');
  assert.equal(info.effectiveValue, 'identity.read, memory.read, memory.write +1 more');
  assert.match(info.precedence ?? '', /current tier is custom/);
});

test('generic runtime setting authority falls back to owner file guidance', () => {
  const info = resolveSettingAuthority(baseData, baseSchema, 'sessionHistoryBudgetPct');
  assert.equal(info.sourceLabel, 'settings.json');
  assert.match(info.detail, /Authoritative source: settings\.json/);
});

test('budget context window authority explains model ownership and precedence', () => {
  const info = resolveBudgetContextWindowAuthority(baseData, {
    contextWindow: 200000,
    systemPromptTokens: 2500,
    maxResponseTokens: 4096,
    resolvedChatProvider: 'openrouter',
    resolvedChatModel: 'gpt-5',
    sessEstimatedCount: 10,
    sessEstimatedTokens: 3500,
    sessTokenBudget: 12000,
    memEstimatedCount: 6,
    memEstimatedTokens: 2400,
    memTokenBudget: 6000,
    allocated: 0,
    remaining: 0,
    sysPct: 0,
    sessPct: 0,
    memPct: 0,
    respPct: 0,
    remainPct: 0,
    variants: [],
  });
  assert.equal(info?.sourceLabel, 'models.json');
  assert.equal(info?.effectiveValue, '200,000 tokens · openrouter / gpt-5');
  assert.match(info?.detail ?? '', /modelCatalog\.chat-primary\.contextWindow/);
  assert.match(info?.precedence ?? '', /explicit modelSelection\.contextWindow wins first/);
});
