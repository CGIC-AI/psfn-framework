import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHARGE_POLICY_FILE_NAME,
  CHARGE_POLICY_SEED_FILE_NAME,
  loadChargePolicyConfig,
  loadChargePolicySeedDefaults,
  saveChargePolicyConfig,
} from './charge-policy-config.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('charge policy config', () => {
  it('loads from seed and persists the owner file when missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-config-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      const seed = {
        schemaVersion: 1,
        runChargeQuotaByLane: {
          interactive: 30,
          background: 10,
          maintenance: 0,
          subagent: 5,
          shard: 16,
        },
        surfaceCosts: {
          ownerFileInspection: 0,
          localFilesystem: 0,
          memoryRead: 0,
          memoryWrite: 0,
          localEmbedding: 0,
          externalEmbedding: 0,
          localImageGeneration: 0,
          paidImageGeneration: 7,
          thinkExtensionBand: 1,
          subagentLaunch: 1,
          shardLaunch: 9,
          externalModelConsult: 2,
          moaRoundBase: 1,
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
      };
      writeJson(join(seedDir, CHARGE_POLICY_SEED_FILE_NAME), seed);

      const loaded = loadChargePolicyConfig(dataDir, { seedDir });
      expect(loaded).toEqual(seed);
      expect(JSON.parse(readFileSync(join(dataDir, CHARGE_POLICY_FILE_NAME), 'utf-8'))).toEqual(seed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads seed defaults without requiring a data directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-seed-defaults-'));
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, CHARGE_POLICY_SEED_FILE_NAME), {
        schemaVersion: 1,
        runChargeQuotaByLane: {
          interactive: 24,
          background: 8,
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
          thinkExtensionBand: 1,
          subagentLaunch: 1,
          shardLaunch: 8,
          externalModelConsult: 1,
          moaRoundBase: 1,
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
      });

      expect(loadChargePolicySeedDefaults({ seedDir })).toEqual({
        schemaVersion: 1,
        runChargeQuotaByLane: {
          interactive: 24,
          background: 8,
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
          thinkExtensionBand: 1,
          subagentLaunch: 1,
          shardLaunch: 8,
          externalModelConsult: 1,
          moaRoundBase: 1,
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
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates and saves the canonical owner-file shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'charge-policy-save-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });

    try {
      const saved = saveChargePolicyConfig(dataDir, {
        schemaVersion: 1,
        runChargeQuotaByLane: {
          interactive: 18,
          background: 6,
          maintenance: 0,
          subagent: 4,
          shard: 10,
        },
        surfaceCosts: {
          ownerFileInspection: 0,
          localFilesystem: 0,
          memoryRead: 0,
          memoryWrite: 0,
          localEmbedding: 0,
          externalEmbedding: 0,
          localImageGeneration: 0,
          paidImageGeneration: 5,
          thinkExtensionBand: 1,
          subagentLaunch: 1,
          shardLaunch: 7,
          externalModelConsult: 1,
          moaRoundBase: 1,
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
      expect(() => saveChargePolicyConfig(dataDir, {
        schemaVersion: 1,
        runChargeQuotaByLane: {
          interactive: 24,
          background: 8,
          maintenance: 0,
          subagent: 6,
          shard: 12,
          ephemeral: 2,
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
          thinkExtensionBand: 1,
          subagentLaunch: 1,
          shardLaunch: 8,
          externalModelConsult: 1,
          moaRoundBase: 1,
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
      })).toThrow('unknown keys');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
