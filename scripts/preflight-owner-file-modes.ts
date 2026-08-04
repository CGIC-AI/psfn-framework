import '../src/shared/utils/load-dotenv.js';
import { loadOperatorConfig } from '../src/system/config/load-config.js';
import { describeStartupOwnerFileChecks } from '../src/system/config/startup-owner-files.js';
import {
  buildOwnerFileModeExpectations,
  formatOwnerFileMode,
  verifyOwnerFileModes,
  type OwnerFileModeExpectation,
} from '../src/system/config/owner-file-modes.js';
import { toErrorMessage } from '../src/shared/utils/errors.js';

/**
 * Rollout owner-file mode/ownership preflight. Run it in a workload that
 * mounts every system and companion root (the fleet gateway mounts each
 * companion PVC at its canonical resolveCompanionFleetPaths path). It never
 * reads or prints owner-file contents or credentials — only stat metadata.
 *
 * Database wiring is resolved operator-style: inline POSTGRES_DATABASE_URL,
 * POSTGRES_DATABASE_URL_FILE, or POSTGRES_DATABASE_URL_FD all work, and the
 * credential is never printed.
 */

function printExpectations(expectations: readonly OwnerFileModeExpectation[]): void {
  process.stdout.write('Canonical owner-file modes (mode path):\n');
  for (const expectation of expectations) {
    const suffix = expectation.optionalWhenMissing ? ' (optional when missing)' : '';
    process.stdout.write(
      `${formatOwnerFileMode(expectation.canonicalMode)} ${expectation.path}${suffix}\n`,
    );
  }
}

function main(): void {
  const printOnly = process.argv.includes('--print-expectations');
  const config = loadOperatorConfig();
  const companionRoots = config.companionFleet
    ? config.companionFleet.companions.map((entry) => ({
      companionId: entry.companionId,
      companionDataDir: entry.companionDataDir,
    }))
    : [{ companionDataDir: config.companionDataDir ?? config.dataDir }];
  const expectations = buildOwnerFileModeExpectations({
    dataDir: config.dataDir,
    companionRoots,
    descriptors: describeStartupOwnerFileChecks(),
  });

  if (printOnly) {
    printExpectations(expectations);
    return;
  }

  const result = verifyOwnerFileModes(expectations);
  for (const entry of result.verified) {
    process.stdout.write(
      `OK ${entry.label} ${entry.path} ${formatOwnerFileMode(entry.mode)} ${entry.uid}:${entry.gid}\n`,
    );
  }
  for (const skipped of result.skippedMissingOptional) {
    process.stdout.write(`SKIP optional owner absent: ${skipped}\n`);
  }
  if (!result.ok) {
    process.stderr.write('Runtime owner-file mode preflight failed:\n');
    for (const error of result.errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Runtime owner-file mode preflight passed: ${result.verified.length} files verified, `
    + `${result.skippedMissingOptional.length} optional absent\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`Runtime owner-file mode preflight failed: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
}
