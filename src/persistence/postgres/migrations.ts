/**
 * Public PostgreSQL migration registry (psfn-framework-emh3p.10).
 *
 * This file is an export-only facade. Each migration chain's SQL is owned by
 * its domain module below, listed in the registry's historical declaration
 * order; consumers keep importing every chain from this path. New migration
 * SQL lands in the owning domain module (never here) and is appended to
 * exactly one chain there. migrations-chain-golden.test.ts pins every
 * chain's statement order and bytes, and migrations-facade.test.ts keeps
 * this file free of SQL.
 */
export { POSTGRES_MEMORY_MIGRATIONS } from './memory-migrations.js';
export { POSTGRES_WIKI_PROJECTION_MIGRATIONS } from './wiki-projection-migrations.js';
export { POSTGRES_CONTACT_MIGRATIONS, POSTGRES_ENROLLMENT_MIGRATIONS } from './contact-migrations.js';
export { POSTGRES_INTENTION_MIGRATIONS } from './intention-migrations.js';
export {
  POSTGRES_AUDIT_MIGRATIONS,
  POSTGRES_TRANSCRIPT_MIGRATIONS,
  POSTGRES_INTERNAL_STATE_MIGRATIONS,
  POSTGRES_PARTICIPANT_TREND_MIGRATIONS,
  POSTGRES_REFLECTION_MIGRATIONS,
} from './session-migrations.js';
export {
  POSTGRES_SCHEDULED_PROMPT_MIGRATIONS,
  POSTGRES_COMPANION_AVAILABILITY_MIGRATIONS,
  POSTGRES_SCHEDULER_LANE_STATE_MIGRATIONS,
} from './scheduler-migrations.js';
export {
  POSTGRES_BACKGROUND_WORK_MIGRATIONS,
  POSTGRES_BACKGROUND_WORK_MIGRATION_ADVISORY_LOCK,
} from './background-work-migrations.js';
export {
  POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK,
  POSTGRES_MODEL_USAGE_MIGRATIONS,
} from './model-usage-migrations.js';
export { POSTGRES_INTROSPECTION_MIGRATIONS, POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS } from './eval-migrations.js';
export {
  SHARED_SCHEMA_NAME,
  POSTGRES_SHARED_BASE_MIGRATION_VERSIONS,
  POSTGRES_SHARED_ALL_MIGRATION_VERSIONS,
  POSTGRES_SHARED_MIGRATIONS,
  POSTGRES_SHARED_WIKI_MIGRATIONS,
} from './shared-schema-migrations.js';
export { POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS } from './partner-affect-shadow-migrations.js';
export { POSTGRES_HEALTH_EVENT_MIGRATIONS, POSTGRES_HUMAN_ESCALATION_MIGRATIONS } from './health-escalation-migrations.js';
export { POSTGRES_ANALYSIS_WORKBENCH_TRACE_MIGRATIONS } from './analysis-workbench-trace-migrations.js';
export { POSTGRES_LETTER_MIGRATIONS, POSTGRES_DOING_MIRROR_MIGRATIONS } from './letter-migrations.js';
export {
  POSTGRES_AUTOMATA_RUN_MIGRATIONS,
  POSTGRES_AUTOMATA_MIGRATIONS,
  POSTGRES_AUTOMATA_ROLLBACK_MIGRATIONS,
} from './automata-migrations.js';
export { POSTGRES_COGSEC_RECEIPT_MIGRATIONS, POSTGRES_COGSEC_BLIND_REVIEW_MIGRATIONS } from './cogsec-migrations.js';
export { POSTGRES_CUSTODY_SNAPSHOT_MIGRATIONS, POSTGRES_EGRESS_DELIVERY_RECORD_MIGRATIONS } from './custody-migrations.js';
