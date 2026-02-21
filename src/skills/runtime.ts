import { createHash } from 'node:crypto';
import {
  loadSkillsConfig,
  type SkillsRuntimeConfig,
} from '../config/skills-config.js';
import { filterEligibleSkills } from './filter.js';
import { formatSkillsForPrompt } from './format.js';
import {
  applySkillPrecedence,
  buildSkillFileSignature,
  loadSkillEntries,
  resolveSkillDirectories,
  scanSkillFiles,
} from './loader.js';
import type {
  SkillSnapshot,
} from './types.js';

export interface SkillsRuntimeOptions {
  dataDir: string;
  seedDir?: string;
  repoRoot?: string;
  environment?: NodeJS.ProcessEnv;
  isBinaryAvailable?: (binaryName: string) => boolean;
}

interface SkillSnapshotCache {
  signature: string;
  snapshot: SkillSnapshot;
}

function hashSignature(payload: string): string {
  return createHash('sha1').update(payload).digest('hex');
}

export class SkillsRuntime {
  private options: SkillsRuntimeOptions;
  private cache: SkillSnapshotCache | null = null;

  constructor(options: SkillsRuntimeOptions) {
    this.options = options;
  }

  invalidate(): void {
    this.cache = null;
  }

  getPromptXml(): string {
    return this.getSnapshot().promptXml;
  }

  getSnapshot(): SkillSnapshot {
    const runtimeConfig = this.loadRuntimeConfig();
    const repoRoot = this.options.repoRoot ?? process.cwd();
    const directories = resolveSkillDirectories(runtimeConfig, repoRoot);
    const files = scanSkillFiles(directories);

    const signaturePayload = JSON.stringify({
      config: {
        enabled: runtimeConfig.enabled,
        directories: runtimeConfig.directories,
        extraDirectories: runtimeConfig.extraDirectories,
        maxLoadedSkills: runtimeConfig.maxLoadedSkills,
        maxSkillChars: runtimeConfig.maxSkillChars,
        disabledSkills: runtimeConfig.disabledSkills,
      },
      directories: directories.map(directory => ({
        relativePath: directory.relativePath,
        precedence: directory.precedence,
        source: directory.source,
      })),
      files: buildSkillFileSignature(files),
    });
    const signature = hashSignature(signaturePayload);

    if (this.cache && this.cache.signature === signature) {
      return this.cache.snapshot;
    }

    const parsed = loadSkillEntries(files);
    const deduped = applySkillPrecedence(parsed.entries);
    const eligibility = filterEligibleSkills(deduped.entries, {
      runtimeConfig,
      environment: this.options.environment,
      isBinaryAvailable: this.options.isBinaryAvailable,
    });

    const formatted = formatSkillsForPrompt(eligibility.eligible, {
      maxSkills: runtimeConfig.maxLoadedSkills,
      maxChars: runtimeConfig.maxSkillChars,
    });

    const snapshot: SkillSnapshot = {
      generatedAt: new Date().toISOString(),
      signature,
      configEnabled: runtimeConfig.enabled,
      budget: {
        maxSkills: runtimeConfig.maxLoadedSkills,
        maxChars: runtimeConfig.maxSkillChars,
      },
      directories,
      scannedFiles: files.length,
      loadedSkills: deduped.entries.length,
      includedSkills: formatted.included,
      promptXml: formatted.xml,
      skipped: [
        ...parsed.skipped,
        ...deduped.skipped,
        ...eligibility.skipped,
        ...formatted.excluded,
      ],
    };

    this.cache = {
      signature,
      snapshot,
    };

    return snapshot;
  }

  private loadRuntimeConfig(): SkillsRuntimeConfig {
    return loadSkillsConfig(this.options.dataDir, {
      seedDir: this.options.seedDir,
    });
  }
}
