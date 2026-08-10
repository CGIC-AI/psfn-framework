import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  maybeCreateIntakeScreeningService,
  type IntakeScreeningService,
} from '../core/cogsec/intake/screening.js';
import { validateIntakePolicy } from '../system/config/intake-policy-config.js';

let shadowScreening: IntakeScreeningService | undefined;

/** Canonical, real L1-only intake service for gateway fixtures. */
export function testShadowIntakeScreening(): IntakeScreeningService {
  if (shadowScreening) return shadowScreening;

  const seed = JSON.parse(
    readFileSync(join(process.cwd(), 'config', 'intake-policy.seed.json'), 'utf8'),
  ) as Record<string, unknown>;
  const screening = maybeCreateIntakeScreeningService({
    policy: validateIntakePolicy({ ...seed, mode: 'shadow' }, 'test-shadow-intake-policy'),
    actor: 'test:gateway-intake-screening',
    l1Config: {
      rulesPath: join(process.cwd(), 'config', 'intake-l1-rules.json'),
    },
  });
  if (!screening) throw new Error('Shadow intake screening must be available in tests');
  shadowScreening = screening;
  return screening;
}
