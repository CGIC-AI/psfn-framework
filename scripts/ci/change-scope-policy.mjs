// Canonical change classifiers shared by the scope detector and local gate
// planner. Keep path semantics here so the two cannot disagree about whether a
// file is product code, a runnable test, or a test dependency.

export const ROOT_RUNNABLE_TEST_PATTERN = /\.test\.[cm]?[jt]sx?$/;
export const ROOT_TEST_FIXTURE_PATTERN = /\.test-fixtures\.[cm]?[jt]sx?$/;

function isRootSourceOrScript(path) {
  return /^(?:src|scripts)\//.test(path);
}

export function isRunnableRootTestPath(path) {
  return isRootSourceOrScript(path) && ROOT_RUNNABLE_TEST_PATTERN.test(path);
}

export function isRootTestFixturePath(path) {
  return isRootSourceOrScript(path) && ROOT_TEST_FIXTURE_PATTERN.test(path);
}

export function isRootTestPath(path) {
  return isRunnableRootTestPath(path) || isRootTestFixturePath(path);
}

// Complete root file graph reached by the fast eval TypeScript build and test
// entries. The scope contract test derives this graph and fails if a new root
// import is introduced without updating this manifest.
export const EVALS_INPUT_PATTERNS = Object.freeze([
  /^tools\/evals\//,
  /^src\/core\/emotion\/(?:calibration|state)\.ts$/,
  /^src\/shared\/contracts\/emotion-contracts\.ts$/,
  /^src\/shared\/utils\/(?:load-dotenv|numeric|types)\.ts$/,
]);

export const ROOT_DTS_ENTRYPOINTS = Object.freeze([
  'src/app/startup/index.ts',
  'src/app/gateway/main.ts',
  'src/app/agent/main.ts',
  'src/app/operator/main.ts',
  'src/app/cert-manager/main.ts',
  'src/app/maintenance/migrate-scheduler-owner.ts',
  'src/app/maintenance/migrate-required-settings-blocks.ts',
  'src/app/maintenance/migrate-intake-policy-owner.ts',
  'src/app/maintenance/migrate-system-owner-fleet.ts',
  'src/app/maintenance/system-owner-fleet-snapshot.ts',
  'src/app/maintenance/owner-upgrade-readiness-probe.ts',
  'src/app/maintenance/resolve-model-usage-ledger-schema.ts',
  'src/app/maintenance/session-integrity-repair.ts',
  'src/persistence/sessions/turn-record-recovery-worker.ts',
  'src/persistence/sessions/turn-tombstone-authority-worker.ts',
  'src/app/maintenance/verify-shell-sandbox-runtime.ts',
  'scripts/preflight-startup-owner-files.ts',
  'scripts/preflight-owner-file-modes.ts',
  'scripts/provision-injection-model.ts',
]);

export function affectsEvals(paths) {
  return paths.some((path) => EVALS_INPUT_PATTERNS.some((pattern) => pattern.test(path)));
}
