// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveBudgetContextWindowAuthority,
  resolveSettingAuthority,
} from './authority.ts';

const baseData = {
  config: {
    maintenanceIntervalMs: 300000,
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
      salienceDecayIntervalMs: 120000,
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
};

const baseSchema = {
  schemaVersion: 1,
  subsystems: {},
  fields: {
    maintenanceIntervalMs: {
      key: 'maintenanceIntervalMs',
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
};

test('maintenance interval authority points at scheduler ownership', () => {
  const info = resolveSettingAuthority(baseData, baseSchema, 'maintenanceIntervalMs');
  assert.equal(info.sourceLabel, 'scheduler.json');
  assert.equal(info.effectiveValue, '120,000 ms');
  assert.match(info.detail, /scheduler\.json > salienceDecayIntervalMs/);
  assert.match(info.precedence ?? '', /mirror/);
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
