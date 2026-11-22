import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_TIER_FILE_NAME,
  loadCapabilityTierConfig,
  type CapabilityTierConfig,
} from '../config/capability-tier-config.js';
import type { CapabilityTier } from '../config/runtime-config-contracts.js';
import type { CapabilityAccess, CapabilityGrantSnapshot } from './access.js';
import { canonicalizeCapabilityTokens } from './shard-derivation.js';
import { resolveTierCapabilityTokens } from './tiers.js';
import type { CapabilityToken } from './tokens.js';
import { canonicalizeDisabledTools } from './tool-overrides.js';

export interface CapabilityRuntimeOptions {
  dataDir: string;
  seedDir?: string;
}

export class CapabilityRuntime implements CapabilityAccess {
  private readonly dataDir: string;
  private readonly seedDir?: string;
  private readonly filePath: string;
  private currentConfig: CapabilityTierConfig;
  private grantedTokens = new Set<CapabilityToken>();
  private disabledTools = new Set<string>();
  private lastFileVersion: string | null;

  constructor(options: CapabilityRuntimeOptions) {
    this.dataDir = options.dataDir;
    this.seedDir = options.seedDir;
    this.filePath = join(options.dataDir, CAPABILITY_TIER_FILE_NAME);

    let config = loadCapabilityTierConfig(this.dataDir, {
      seedDir: this.seedDir,
    });

    this.currentConfig = config;
    this.applyLoadedConfig(config);
    this.lastFileVersion = this.readFileVersion();
  }

  getTier(): CapabilityTier {
    this.ensureFresh();
    return this.currentConfig.tier;
  }

  getGrantedTokens(): ReadonlySet<CapabilityToken> {
    this.ensureFresh();
    return this.grantedTokens;
  }

  has(token: CapabilityToken): boolean {
    this.ensureFresh();
    return this.grantedTokens.has(token);
  }

  getDisabledTools(): ReadonlySet<string> {
    this.ensureFresh();
    return this.disabledTools;
  }

  isToolDisabled(toolName: string): boolean {
    this.ensureFresh();
    return this.disabledTools.has(toolName);
  }

  /**
   * One atomic authoritative owner snapshot (mus2.1): a single validated disk
   * read produces the tier, the authoritative custom token list, the effective
   * granted tokens, and the per-companion disabled tool overrides together, so
   * the result can never mix two owner-file versions the way sequenced getters
   * can. The internal cache is refreshed from that same read.
   */
  snapshotOwnerGrant(): CapabilityGrantSnapshot {
    const loaded = this.refreshFromDisk();
    const customTokens = canonicalizeCapabilityTokens(loaded.customTokens, 'customTokens');
    const grantedTokens = canonicalizeCapabilityTokens(
      resolveTierCapabilityTokens(loaded.tier, loaded.customTokens),
      `tier "${loaded.tier}" grant`,
    );
    const disabledTools = canonicalizeDisabledTools(loaded.disabledTools, 'disabledTools');
    return Object.freeze({
      tier: loaded.tier,
      customTokens,
      grantedTokens,
      disabledTools,
    });
  }

  refreshFromDisk(): CapabilityTierConfig {
    const loaded = loadCapabilityTierConfig(this.dataDir, {
      seedDir: this.seedDir,
    });
    this.currentConfig = loaded;
    this.applyLoadedConfig(loaded);
    this.lastFileVersion = this.readFileVersion();
    return loaded;
  }

  private applyLoadedConfig(config: CapabilityTierConfig): void {
    this.grantedTokens = new Set(
      resolveTierCapabilityTokens(config.tier, config.customTokens),
    );
    this.disabledTools = new Set(config.disabledTools);
  }

  private ensureFresh(): void {
    const nextVersion = this.readFileVersion();
    if (nextVersion === this.lastFileVersion) return;
    this.refreshFromDisk();
  }

  private readFileVersion(): string | null {
    try {
      const stats = statSync(this.filePath);
      return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
    } catch {
      return null;
    }
  }
}
