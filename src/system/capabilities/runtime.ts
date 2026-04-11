import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_TIER_FILE_NAME,
  loadCapabilityTierConfig,
  type CapabilityTierConfig,
} from '../config/capability-tier-config.js';
import type { CapabilityTier } from '../config/runtime-config-contracts.js';
import type { CapabilityAccess } from './access.js';
import { resolveTierCapabilityTokens } from './tiers.js';
import type { CapabilityToken } from './tokens.js';

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
  private lastFileVersion: string | null;

  constructor(options: CapabilityRuntimeOptions) {
    this.dataDir = options.dataDir;
    this.seedDir = options.seedDir;
    this.filePath = join(options.dataDir, CAPABILITY_TIER_FILE_NAME);

    let config = loadCapabilityTierConfig(this.dataDir, {
      seedDir: this.seedDir,
    });

    this.currentConfig = config;
    this.setGrantedTokens(config);
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

  refreshFromDisk(): CapabilityTierConfig {
    const loaded = loadCapabilityTierConfig(this.dataDir, {
      seedDir: this.seedDir,
    });
    this.currentConfig = loaded;
    this.setGrantedTokens(loaded);
    this.lastFileVersion = this.readFileVersion();
    return loaded;
  }

  private setGrantedTokens(config: CapabilityTierConfig): void {
    this.grantedTokens = new Set(
      resolveTierCapabilityTokens(config.tier, config.customTokens),
    );
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
