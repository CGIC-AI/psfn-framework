import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(fileURLToPath(import.meta.url));

const OWNERS = [
  'primitives.ts:toInterval,toPositiveInteger,toBoolean,toNumberAtLeast,toUnitFactor,toPositiveUnitFactor,toLocalTime,toTimeZone,toUnitInterval,toCadenceTimezone,toWakeTimingMode,toHourOfDay,toPositiveNumber,toNonEmptyString,toNonNegativeInteger',
  'background-work.ts:DEFAULT_BACKGROUND_WORK_TUNING,validateBackgroundWorkConfig,BackgroundWorkWelfareConfig,DEFAULT_BACKGROUND_WORK_WELFARE_CONFIG,validateBackgroundWorkWelfareConfig',
  'maintenance.ts:ArtifactLifecyclePolicyConfig,validateArtifactLifecycleConfig,BackgroundMaintenanceConfig,DEFAULT_BACKGROUND_MAINTENANCE_CONFIG,validateBackgroundMaintenanceConfig',
  'social-autonomy.ts:SocialAutonomyConfig,createDefaultSocialAutonomyConfig,DEFAULT_SOCIAL_AUTONOMY_CONFIG,validateSocialAutonomyConfig',
  'social-graph.ts:SocialGraphBuilderCadenceConfig,DEFAULT_SOCIAL_GRAPH_BUILDER_CADENCE,validateSocialGraphBuilderConfig',
].map((owner) => {
  const [file, tokens] = owner.split(':');
  return { file, tokens: tokens.split(',') };
});

describe('scheduler configuration P1 module boundaries', () => {
  it('moves foundational/background/maintenance/social blocks to owned modules', () => {
    const facade = readFileSync(join(ROOT, 'scheduler-config.ts'), 'utf8');
    for (const { file, tokens } of OWNERS) {
      const source = readFileSync(join(ROOT, 'scheduler-config', file), 'utf8');
      for (const token of tokens) {
        expect(source, `${file} must own ${token}`).toContain(token);
      }
      // Each owner module must be imported by the facade.
      expect(facade).toContain(`from './scheduler-config/${file.replace('.ts', '')}.js'`);
    }
  });
});
