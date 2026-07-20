import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChargePolicySurface } from './charge-policy-config.js';
import {
  CHARGE_POLICY_FILE_NAME,
  CHARGE_POLICY_SEED_FILE_NAME,
  loadChargePolicyConfig,
  loadChargePolicySeedDefaults,
  saveChargePolicyConfig,
} from './charge-policy-config.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function repeatSurface(surface: ChargePolicySurface, count: number): ChargePolicySurface[] {
  return Array.from({ length: count }, () => surface);
}

function getDefaultSeedPolicy() {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 24,
      companion_social: 12,
      background: 16,
      maintenance: 0,
      subagent: 6,
      shard: 12,
    },
    surfaceCosts: {
      ownerFileInspection: 0,
      localFilesystem: 0,
      memoryRead: 0,
      memoryWrite: 0,
      localEmbedding: 0,
      externalEmbedding: 0,
      localImageGeneration: 0,
      paidImageGeneration: 6,
      analysisWorkbenchExtensionBand: 4,
      subagentLaunch: 1,
      shardLaunch: 8,
      externalModelConsult: 1,
      moaRoundBase: 1,
      companionSocialContinuation: 1,
    },
    surfaceRationales: {
      paidImageGeneration: 'External image generation spends paid provider credits.',
      analysisWorkbenchExtensionBand: 'Extended analysis workbench loops reserve scarce deep-analysis budget after the first pass.',
      subagentLaunch: 'Spawning a subagent reserves a separate runtime budget.',
      shardLaunch: 'Launching a shard consumes worker coordination overhead.',
      externalModelConsult: 'Consulting an external model uses a paid API boundary.',
      moaRoundBase: 'Each MOA round carries coordination overhead even before model spend.',
      companionSocialContinuation: 'After the soft allowance, each autonomous companion continuation spends marginal social charge.',
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 1,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 2,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 4,
    },
    referenceModelClassPricingRationales: {
      cheap_cloud: 'Cheap cloud models are lightly priced to keep them available for routine use.',
      premium_cloud: 'Premium cloud models are intentionally more expensive to reserve for high-value calls.',
    },
    icpCostBreaker: {
      enabled: false,
    },
    fatigue: makeTestFatiguePolicyConfig(),
  };
}

describe('charge policy config', () => {
  it('fails closed when the owner file is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-config-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      const defaultSeed = getDefaultSeedPolicy();
      const seed = {
        ...defaultSeed,
        runChargeQuotaByLane: {
          interactive: 30,
          background: 10,
          maintenance: 0,
          subagent: 5,
          shard: 16,
        },
        surfaceCosts: {
          ...defaultSeed.surfaceCosts,
          paidImageGeneration: 7,
          shardLaunch: 9,
          externalModelConsult: 2,
        },
        moa: {
          perRoundMultiplierByReferenceModelClass: {
            local: 1,
            subscription: 1,
            cheap_cloud: 1,
            premium_cloud: 3,
          },
        },
        referenceModelClassPricing: {
          local: 0,
          subscription: 0,
          cheap_cloud: 1,
          premium_cloud: 5,
        },
        referenceModelClassPricingRationales: defaultSeed.referenceModelClassPricingRationales,
        surfaceRationales: {
          ...defaultSeed.surfaceRationales,
          paidImageGeneration: 'External image generation spends paid provider credits.',
          shardLaunch: 'Launching a shard consumes worker coordination overhead.',
          externalModelConsult: 'Consulting an external model uses a paid API boundary.',
        },
      };
      writeJson(join(seedDir, CHARGE_POLICY_SEED_FILE_NAME), seed);

      expect(() => loadChargePolicyConfig(dataDir, { seedDir })).toThrow(
        'Missing required JSON owner file',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads an explicit owner file without copying the seed', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-config-explicit-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      const defaultSeed = getDefaultSeedPolicy();
      const owner = {
        ...defaultSeed,
        runChargeQuotaByLane: {
          ...defaultSeed.runChargeQuotaByLane,
          interactive: 30,
        },
      };
      writeJson(join(seedDir, CHARGE_POLICY_SEED_FILE_NAME), defaultSeed);
      writeJson(join(dataDir, CHARGE_POLICY_FILE_NAME), owner);

      expect(loadChargePolicyConfig(dataDir, { seedDir })).toEqual(owner);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads seed defaults without requiring a data directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-seed-defaults-'));
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir, { recursive: true });

    try {
      const defaultSeed = getDefaultSeedPolicy();
      writeJson(join(seedDir, CHARGE_POLICY_SEED_FILE_NAME), defaultSeed);

      const seed = loadChargePolicySeedDefaults({ seedDir });
      expect(seed).toEqual(defaultSeed);

      const representativeRun: ChargePolicySurface[] = [
        ...repeatSurface('ownerFileInspection', 8),
        ...repeatSurface('localFilesystem', 8),
        ...repeatSurface('memoryRead', 6),
        ...repeatSurface('memoryWrite', 6),
        ...repeatSurface('localEmbedding', 4),
        ...repeatSurface('externalEmbedding', 4),
        ...repeatSurface('localImageGeneration', 4),
        'paidImageGeneration',
        'analysisWorkbenchExtensionBand',
        'subagentLaunch',
        'shardLaunch',
        'externalModelConsult',
        'moaRoundBase',
      ];
      const zeroCostCalls = representativeRun.filter(surface => seed.surfaceCosts[surface] === 0).length;
      expect(zeroCostCalls / representativeRun.length).toBeGreaterThan(0.8);
      const surfaceRationales = seed.surfaceRationales ?? {};
      expect(Object.entries(seed.surfaceCosts).filter(([, amount]) => amount > 0).every(([surface]) => {
        const rationale = surfaceRationales[surface as keyof typeof surfaceRationales];
        return typeof rationale === 'string' && rationale.trim().length > 0;
      })).toBe(true);
      const referenceRationales = seed.referenceModelClassPricingRationales ?? {};
      expect(Object.entries(seed.referenceModelClassPricing).filter(([, amount]) => amount > 0).every(([modelClass]) => {
        const rationale = referenceRationales[modelClass as keyof typeof referenceRationales];
        return typeof rationale === 'string' && rationale.trim().length > 0;
      })).toBe(true);
      expect(seed.fatigue.relationshipBudgets.weak_mi).toEqual({
        softTarget: 2,
        hardCap: 5,
      });
      expect(seed.fatigue.channelSettingLimits.busy_human_group).toEqual({
        maxSoftTarget: 2,
        maxHardCap: 5,
      });
      expect(seed.fatigue.channelSettingLimits.dm.maxHardCap).toBeGreaterThan(
        seed.fatigue.channelSettingLimits.busy_human_group.maxHardCap,
      );
      expect(seed.fatigue.overcharge.reserveResponses).toBe(2);
      expect(seed.icpCostBreaker).toEqual({ enabled: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts an explicitly enabled ICP breaker with a fully reserved warning band', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-icp-cost-breaker-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    try {
      const saved = saveChargePolicyConfig(dataDir, {
        ...getDefaultSeedPolicy(),
        icpCostBreaker: {
          enabled: true,
          warningThresholdUsd: 0.42,
          hardLimitUsd: 0.5,
          finalCloseoutReserveUsd: 0.08,
          pendingReservationStaleAfterMs: 900_000,
          includedCostPurposes: {
            conversation_turn: true,
            tool: true,
            summary: true,
            extraction: true,
            sidecar: true,
          },
        },
      });

      expect(saved.icpCostBreaker).toEqual({
        enabled: true,
        warningThresholdUsd: 0.42,
        hardLimitUsd: 0.5,
        finalCloseoutReserveUsd: 0.08,
        pendingReservationStaleAfterMs: 900_000,
        includedCostPurposes: {
          conversation_turn: true,
          tool: true,
          summary: true,
          extraction: true,
          sidecar: true,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing thresholds', { enabled: true }],
    ['unknown field', { enabled: false, hardLimitUsd: 1 }],
    ['warning reserve gap', {
      enabled: true,
      warningThresholdUsd: 0.4,
      hardLimitUsd: 0.6,
      finalCloseoutReserveUsd: 0.1,
      pendingReservationStaleAfterMs: 900_000,
      includedCostPurposes: {
        conversation_turn: true,
        tool: true,
        summary: true,
        extraction: true,
        sidecar: true,
      },
    }],
    ['direct turn excluded', {
      enabled: true,
      warningThresholdUsd: 0.4,
      hardLimitUsd: 0.5,
      finalCloseoutReserveUsd: 0.1,
      pendingReservationStaleAfterMs: 900_000,
      includedCostPurposes: {
        conversation_turn: false,
        tool: true,
        summary: true,
        extraction: true,
        sidecar: true,
      },
    }],
  ])('fails closed on malformed ICP cost-breaker policy: %s', (_label, icpCostBreaker) => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-invalid-icp-cost-breaker-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    try {
      expect(() => saveChargePolicyConfig(dataDir, {
        ...getDefaultSeedPolicy(),
        icpCostBreaker,
      })).toThrow(/Invalid charge policy/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when social fatigue charge disagrees with the canonical surface cost', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-social-cost-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      const policy = getDefaultSeedPolicy();
      writeJson(join(seedDir, CHARGE_POLICY_SEED_FILE_NAME), policy);
      writeJson(join(dataDir, CHARGE_POLICY_FILE_NAME), {
        ...policy,
        fatigue: {
          ...policy.fatigue,
          socialRegulation: {
            ...policy.fatigue.socialRegulation,
            marginalChargeUnits: 2,
          },
        },
      });

      expect(() => loadChargePolicyConfig(dataDir, { seedDir })).toThrow(
        'fatigue.socialRegulation.marginalChargeUnits must equal surfaceCosts.companionSocialContinuation',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates and saves the canonical owner-file shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-save-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    try {
      const defaultSeed = getDefaultSeedPolicy();
      const saved = saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        runChargeQuotaByLane: {
          interactive: 18,
          companion_social: 9,
          background: 6,
          maintenance: 0,
          subagent: 4,
          shard: 10,
        },
        surfaceCosts: {
          ...defaultSeed.surfaceCosts,
          paidImageGeneration: 5,
          shardLaunch: 7,
        },
        moa: {
          perRoundMultiplierByReferenceModelClass: {
            local: 1,
            subscription: 1,
            cheap_cloud: 1,
            premium_cloud: 2.5,
          },
        },
        referenceModelClassPricing: {
          local: 0,
          subscription: 0,
          cheap_cloud: 0.5,
          premium_cloud: 3,
        },
      });

      expect(saved.referenceModelClassPricing.premium_cloud).toBe(3);
      expect(saved.surfaceRationales?.paidImageGeneration).toContain('paid provider credits');
      expect(JSON.parse(readFileSync(join(dataDir, CHARGE_POLICY_FILE_NAME), 'utf-8'))).toEqual(saved);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on schema drift and unknown keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-invalid-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    try {
      const defaultSeed = getDefaultSeedPolicy();
      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        runChargeQuotaByLane: {
          interactive: 24,
          background: 8,
          maintenance: 0,
          subagent: 6,
          shard: 12,
          ephemeral: 2,
        },
        moa: {
          perRoundMultiplierByReferenceModelClass: {
            local: 1,
            subscription: 1,
            cheap_cloud: 1,
            premium_cloud: 2,
          },
        },
        surfaceCosts: {
          ...defaultSeed.surfaceCosts,
          paidImageGeneration: 6,
          externalModelConsult: 1,
        },
        referenceModelClassPricing: {
          ...defaultSeed.referenceModelClassPricing,
          cheap_cloud: 1,
          premium_cloud: 4,
        },
      })).toThrow('unknown keys');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        surfaceRationales: {
          shardLaunch: 'Launching a shard consumes worker coordination overhead.',
        },
      })).toThrow(/surfaceRationales must include non-empty entries for nonzero .*paidImageGeneration/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed fatigue policy values', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-invalid-fatigue-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    try {
      const defaultSeed = getDefaultSeedPolicy();
      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          relationshipBudgets: {
            ...defaultSeed.fatigue.relationshipBudgets,
            weak_mi: {
              softTarget: -1,
              hardCap: 5,
            },
          },
        },
      })).toThrow('fatigue.relationshipBudgets.weak_mi.softTarget must be a finite integer >= 0');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          relationshipBudgets: {
            ...defaultSeed.fatigue.relationshipBudgets,
            weak_mi: {
              softTarget: 6,
              hardCap: 5,
            },
          },
        },
      })).toThrow('fatigue.relationshipBudgets.weak_mi.hardCap must be >=');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          intentMultipliers: {
            ...defaultSeed.fatigue.intentMultipliers,
            banter: {
              softTargetMultiplier: 1,
              hardCapMultiplier: 1,
            },
          },
        },
      })).toThrow('fatigue.intentMultipliers contains unknown keys: banter');

      const { weak_mi: _weakMi, ...missingRelationshipBudgets } = defaultSeed.fatigue.relationshipBudgets;
      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          relationshipBudgets: missingRelationshipBudgets,
        },
      })).toThrow('fatigue.relationshipBudgets.weak_mi must be an object');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          overcharge: {
            ...defaultSeed.fatigue.overcharge,
            reserveResponses: -1,
          },
        },
      })).toThrow('fatigue.overcharge.reserveResponses must be a finite integer > 0');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          overcharge: {
            ...defaultSeed.fatigue.overcharge,
            reserveResponses: 99,
          },
        },
      })).toThrow('fatigue.overcharge.reserveResponses must be <= 10');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          socialRegulation: {
            ...defaultSeed.fatigue.socialRegulation,
            conversationMaturingRatio: 1,
          },
        },
      })).toThrow('fatigue.socialRegulation.conversationMaturingRatio must be > 0 and < 1');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          socialRegulation: {
            ...defaultSeed.fatigue.socialRegulation,
            relationshipPressureWindowMs: 1,
          },
        },
      })).toThrow('fatigue.socialRegulation.relationshipPressureWindowMs must be >=');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          socialRegulation: {
            ...defaultSeed.fatigue.socialRegulation,
            dailyMessageQuota: 8,
          },
        },
      })).toThrow('fatigue.socialRegulation contains unknown keys: dailyMessageQuota');

      const { primary: _primary, ...missingPrimaryThreshold } =
        defaultSeed.fatigue.humanAttention.trustThresholds;
      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          humanAttention: {
            ...defaultSeed.fatigue.humanAttention,
            trustThresholds: missingPrimaryThreshold,
          },
        },
      })).toThrow('fatigue.humanAttention.trustThresholds.primary');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          humanAttention: {
            ...defaultSeed.fatigue.humanAttention,
            trustThresholds: {
              ...defaultSeed.fatigue.humanAttention.trustThresholds,
              trusted: 2,
            },
          },
        },
      })).toThrow('humanAttention trust thresholds must strictly increase');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          humanAttention: {
            ...defaultSeed.fatigue.humanAttention,
            trustThresholds: {
              public: 3,
              regular: 6,
              trusted: 12,
              primary: 12,
            },
          },
        },
      })).toThrow('humanAttention trust thresholds must strictly increase');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          humanAttention: {
            ...defaultSeed.fatigue.humanAttention,
            trustThresholds: {
              public: 1,
              regular: 2,
              trusted: 3,
              primary: 4,
            },
            channelWeights: {
              ...defaultSeed.fatigue.humanAttention.channelWeights,
              directMention: 4,
            },
          },
        },
      })).toThrow('primary threshold must exceed every single-message channel weight');

      expect(() => saveChargePolicyConfig(dataDir, {
        ...defaultSeed,
        fatigue: {
          ...defaultSeed.fatigue,
          humanAttention: {
            ...defaultSeed.fatigue.humanAttention,
            channelWeights: {
              ...defaultSeed.fatigue.humanAttention.channelWeights,
              directMention: 0,
            },
          },
        },
      })).toThrow('fatigue.humanAttention.channelWeights.directMention must be a finite number > 0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
