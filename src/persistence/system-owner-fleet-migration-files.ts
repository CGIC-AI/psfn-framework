import { CHARGE_POLICY_FILE_NAME } from '../system/config/charge-policy-config.js';
import { SKILLS_FILE_NAME } from '../system/config/skills-config.js';

/**
 * System-root owners handled by the whole-install fan-out transaction.
 * Scheduler and capability-tier use a separate per-release Helm cutover that
 * deliberately retains their old sources as rollback evidence.
 */
export const SYSTEM_OWNER_FLEET_MIGRATION_FILES = new Set([
  CHARGE_POLICY_FILE_NAME,
  SKILLS_FILE_NAME,
]);
