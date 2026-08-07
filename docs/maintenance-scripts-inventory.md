# Maintenance Scripts Inventory

This document inventories the operational CLI surface under `src/app/maintenance`
and the related `npm run` scripts. It exists to make the Live Alpha Migration
Boundary in `docs/specifications.md` exhaustive and to track which tools are
sanctioned for recurring use, which are one-shot migrations awaiting fleet
completion, and which should be retired once verified.

Last updated: 2026-08-07.

## Classification key

| Class | Meaning |
|---|---|
| `recurring` | Supported operator utility or verifier. Keep; documented authority exists. |
| `sanctioned-repair` | Repair/audit tool that may be re-run against live data. Keep. |
| `migration-in-progress` | Fleet-wide schema/data migration that is not complete on every live installation. Keep and track completion criteria. |
| `retire-after-verification` | One-shot migration or import that should be removed after the operator confirms it has run everywhere. |

## npm script inventory

| Script | Entry file | Class | Authority / removal criteria |
|---|---|---|---|
| `audit:core-memory-scopes` | `src/app/maintenance/audit-core-memory-scopes.ts` | `sanctioned-repair` | Operator audit for memory-scope policy drift; may be re-run. |
| `audit:prompt-macros` | `src/app/maintenance/audit-prompt-layer-macros.ts` | `sanctioned-repair` | Operator audit for prompt-layer macro usage; may be re-run. |
| `memory:repair:participant-names` | `src/app/maintenance/backfill-memory-participant-names.ts` | `sanctioned-repair` | Backfills memory participant names; idempotent repair. |
| `memory:repair:provenance` | `src/app/maintenance/backfill-memory-provenance.ts` | `sanctioned-repair` | Backfills memory provenance fields; idempotent repair. |
| `memory:repair:subject-attribution` | `src/app/maintenance/reattribute-memory-subjects.ts` | `sanctioned-repair` | Re-attribution repair for memory subjects; idempotent. |
| `migrate:channel-envelope` | `src/app/maintenance/migrate-channel-envelope.ts` | `migration-in-progress` | Channel-owned privacy label migration (Context Envelope E3.2). **Removal:** after every companion's `channels.json` owns channel envelope labels and no trust-policy overrides remain active. See `docs/context-envelope.md`. |
| `migrate:embeddings` | `src/app/maintenance/migrate-embeddings.ts` | `retire-after-verification` | Re-embeds all L2 memories. Added to the Live Alpha Migration Boundary as a one-time provider-cutover tool. **Removal:** after every live installation has rebuilt its L2 embedding space with the target in-process Transformers provider and a bounded retrieval smoke passes. |
| `migrate:intake-policy-owner` | `src/app/maintenance/migrate-intake-policy-owner.ts` | `migration-in-progress` | Sanctioned in `docs/specifications.md`. **Removal:** before beta after every system owner uses canonical schema v4. |
| `migrate:persistence-layout` | `src/app/maintenance/migrate-persistence-layout.ts` | `migration-in-progress` | Sanctioned in `docs/specifications.md`. **Removal:** before beta after every split cluster has completed cutover. |
| `migrate:prompt-layer-identifiers` | `src/app/maintenance/backfill-prompt-layer-identifiers.ts` | `retire-after-verification` | Backfills missing base-layer identifiers. Added to the Live Alpha Migration Boundary as a one-time backfill. **Removal:** before beta after every companion's base prompt-layer records carry an explicit identifier and the fail-closed path in `src/core/identity/prompt-manager.ts` is validated. |
| `migrate:scheduler-owner` | `src/app/maintenance/migrate-scheduler-owner.ts` | `migration-in-progress` | Sanctioned in `docs/specifications.md`. **Removal:** before beta after every companion owner has the canonical scheduler shape. |
| `migrate:session-filenames` | `src/app/maintenance/migrate-session-filenames.ts` | `migration-in-progress` | Sanctioned in `docs/specifications.md`. **Removal:** before beta after every supported companion session root uses readable filenames. |
| `migrate:system-owner-fleet` | `src/app/maintenance/migrate-system-owner-fleet.ts` | `migration-in-progress` | Sanctioned in `docs/specifications.md`. **Removal:** before beta after every split cluster has a completed receipt. |
| `projects:migrate-free-time-visibility` | `src/app/maintenance/migrate-free-time-visibility.ts` | `retire-after-verification` | One-time project free-time visibility migration. **Removal:** after operator confirms the migration has run on every live installation. |
| `projects:migrate-manifests-v2` | `src/app/maintenance/migrate-project-manifests-v2.ts` | `retire-after-verification` | One-time project manifest v2 migration. **Removal:** after operator confirms every live project manifest is at v2. |
| `projects:quarantine-legacy-artifacts` | `src/app/maintenance/quarantine-legacy-project-artifacts.ts` | `retire-after-verification` | One-time legacy project artifact quarantine. **Removal:** after operator confirms legacy artifacts are quarantined everywhere. |
| `restore:system-owner-fleet-snapshot` | `src/app/maintenance/system-owner-fleet-snapshot.ts` | `recurring` | Disaster-recovery restore command; referenced by `docs/operations.md` and Helm tests. |
| `seed:sibling-contacts` | `src/app/maintenance/seed-sibling-contacts.ts` | `sanctioned-repair` | Idempotent companion-fleet contact seeding helper. |
| `session:purge` | `src/app/maintenance/purge-testing-session.ts` | `recurring` | Testing-session purge utility. |
| `session:repair` | `src/app/maintenance/session-repair.ts` | `sanctioned-repair` | General session repair entrypoint. |
| `session:repair:attribution` | `src/app/maintenance/session-attribution-repair.ts` | `sanctioned-repair` | Session attribution repair. |
| `session:repair:integrity` | `src/app/maintenance/session-integrity-repair.ts` | `sanctioned-repair` | Session HMAC integrity repair; built by `tsup` for in-pod use. |
| `session:repair:transcript-projection` | `src/app/maintenance/transcript-projection-repair.ts` | `sanctioned-repair` | Transcript projection repair. |
| `snapshot:system-owner-fleet` | `src/app/maintenance/system-owner-fleet-snapshot.ts` | `recurring` | Disaster-recovery snapshot capture; referenced by `docs/operations.md` and Helm tests. |
| `wiki:import` | `src/app/maintenance/import-wiki.ts` | `retire-after-verification` | One-time wiki import helper. **Removal:** after operator confirms the import has run on every live installation. |
| `wiki:publish:places` | `src/app/maintenance/publish-places-wiki.ts` | `retire-after-verification` | One-time places-wiki publish helper. **Removal:** after operator confirms the publish has run on every live installation. |
| `import_character` | `src/app/maintenance/import-character.ts` | `retire-after-verification` | One-time character import helper. **Removal:** after operator confirms the import has run on every live installation. |

## `src/app/maintenance` file inventory

Files are grouped by the npm script they implement or support. Test files are
listed with their corresponding implementation file.

### Recurring / sanctioned-repair utilities

| File | Role | Wired from |
|---|---|---|
| `audit-core-memory-scopes.ts` | `audit:core-memory-scopes` | `package.json` |
| `audit-prompt-layer-macros.ts` | `audit:prompt-macros` | `package.json` |
| `backfill-memory-participant-names.ts` | `memory:repair:participant-names` | `package.json` |
| `backfill-memory-provenance.ts` | `memory:repair:provenance` | `package.json` |
| `reattribute-memory-subjects.ts` + `.test.ts` | `memory:repair:subject-attribution` | `package.json` |
| `seed-sibling-contacts.ts` + `.test.ts` | `seed:sibling-contacts` | `package.json` |
| `purge-testing-session.ts` + `.test.ts` | `session:purge` | `package.json` |
| `session-repair.ts` | `session:repair` | `package.json` |
| `session-attribution-repair.ts` | `session:repair:attribution` | `package.json` |
| `session-integrity-repair.ts` | `session:repair:integrity` | `package.json`, `tsup.config.ts` |
| `transcript-projection-repair.ts` + `.test.ts` | `session:repair:transcript-projection` | `package.json` |

### Fleet migrations sanctioned by the Live Alpha Migration Boundary

| File | Role | Wired from |
|---|---|---|
| `migrate-intake-policy-owner.ts` | `migrate:intake-policy-owner` | `package.json`, `tsup.config.ts` |
| `migrate-persistence-layout.ts` | `migrate:persistence-layout` | `package.json` |
| `migrate-scheduler-owner.ts` | `migrate:scheduler-owner` | `package.json`, `tsup.config.ts` |
| `migrate-session-filenames.ts` + `.e2e.test.ts` | `migrate:session-filenames` | `package.json` |
| `migrate-system-owner-fleet.ts` | `migrate:system-owner-fleet` | `package.json`, `tsup.config.ts` |
| `system-owner-fleet-snapshot.ts` | `snapshot:system-owner-fleet`, `restore:system-owner-fleet-snapshot` | `package.json`, `tsup.config.ts` |
| `system-owner-fleet-context.ts` + `.test.ts` | Shared logic for system-owner-fleet migration | `migrate-system-owner-fleet.ts` |
| `owner-upgrade-readiness-probe.ts` | Packaged readiness probe for owner upgrade | `tsup.config.ts`, `deploy/helm/psfn/templates/owner-migration-upgrade.yaml` |

### Migrations added to the boundary by this audit

| File | Role | Wired from |
|---|---|---|
| `migrate-embeddings.ts` | `migrate:embeddings` | `package.json` |
| `backfill-prompt-layer-identifiers.ts` + `.test.ts` | `migrate:prompt-layer-identifiers` | `package.json` |
| `prompt-layer-identifier-backfill.ts` | Backfill logic used by the above | `backfill-prompt-layer-identifiers.ts` |
| `migrate-channel-envelope.ts` | `migrate:channel-envelope` | `package.json` |
| `channel-envelope-migration-support.ts` + `.test.ts` | Planning support for the above | `migrate-channel-envelope.ts` |

### One-shot imports / project migrations (retire after verification)

| File | Role | Wired from |
|---|---|---|
| `import-character.ts` | `import_character` | `package.json` |
| `import-wiki.ts` | `wiki:import` | `package.json` |
| `publish-places-wiki.ts` | `wiki:publish:places` | `package.json` |
| `shared-wiki-projection-context.ts` | Shared wiki projection context | `import-wiki.ts`, `publish-places-wiki.ts` |
| `migrate-free-time-visibility.ts` | `projects:migrate-free-time-visibility` | `package.json` |
| `migrate-project-manifests-v2.ts` | `projects:migrate-manifests-v2` | `package.json` |
| `quarantine-legacy-project-artifacts.ts` | `projects:quarantine-legacy-artifacts` | `package.json` |

### Shared maintenance CLI harness

| File | Role | Wired from |
|---|---|---|
| `cli-harness.ts` + `.test.ts` | Shared argument parsing and runtime bootstrap for maintenance CLIs | All maintenance CLIs listed above |
| `fleet-contact-provisioning.ts` + `.test.ts` | Shared fleet contact provisioning logic | `seed-sibling-contacts.ts` |
| `testing-session-purge-postgres.ts` + `.test.ts` | Postgres implementation of testing-session purge | `purge-testing-session.ts` |
| `testing-session-purge-target.ts` | Target abstraction for testing-session purge | `purge-testing-session.ts`, `testing-session-purge-postgres.ts` |

### Verified production / Helm wiring (do not remove without replacing)

| File | Role | Wired from |
|---|---|---|
| `migrate-required-settings-blocks.ts` | Helm init-time owner-file block migration | `tsup.config.ts`, `deploy/helm/psfn/templates/_helpers.tpl`, `docs/helm-upgrades.md`, `scripts/verify-helm-chart.mjs`, `knip.json` |
| `verify-shell-sandbox-runtime.ts` | Bubblewrap sandbox runtime verification | `tsup.config.ts`, `scripts/verify-shell-sandbox-image.mjs`, `config/identity-literal-scan-allowlist.json` |
| `resolve-model-usage-ledger-schema.ts` + `.test.ts` | Kube rollout schema resolution | `tsup.config.ts`, `scripts/ops/validate-kube-rollout.sh` |

### Legacy / tracked separately

| File | Role | Wired from |
|---|---|---|
| `force-episodic-synthesis.ts` | SQLite-only legacy episodic synthesis helper | `package.json`; retirement tracked in `psfn-framework-3c2.7` |

### Script verification tests

The `script-verification/` subdirectory contains tests that assert repo-owned
scripts and gates behave correctly. They are not production entrypoints and
should be kept as long as the scripts they cover exist.

## Wiring surfaces to check before deleting any maintenance entry

When retiring a maintenance CLI, remove or update all of the following that
reference it:

1. `package.json` script entry.
2. `tsup.config.ts` entry, if present.
3. `knip.json` entry/ignore, if present.
4. Helm templates under `deploy/helm/psfn/templates/` and `_helpers.tpl`.
5. Helm verifier scripts: `scripts/verify-helm-chart.mjs`, `scripts/verify-helm-charge-skills-owner-upgrade*.mjs`.
6. Shell rollout scripts: `scripts/ops/validate-kube-rollout.sh`, `scripts/start-gateway-agent.sh`.
7. Documentation: `docs/specifications.md`, `docs/operations.md`, `docs/context-envelope.md`, `docs/helm-upgrades.md`, `docs/setup.md`.
8. Admin / UI strings that name the command.
9. Tests that import the module or assert the script exists.
10. Baseline / allowlist metadata that names the file's literals.
