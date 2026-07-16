import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  restoreFleetCompanionSlice,
  type FleetRestoreFaultStage,
} from '../fleet-restore.js';

const [
  fleetManifestPath,
  companionId,
  companionDataDir,
  personalWorkspacePath,
  databaseUrl,
  pgRestoreBinary,
  psqlBinary,
  faultStage,
  rawPublishedTreeCount = '0',
] = process.argv.slice(2);

if (!fleetManifestPath
  || !companionId
  || !companionDataDir
  || !personalWorkspacePath
  || !databaseUrl
  || !pgRestoreBinary
  || !psqlBinary
  || !faultStage) {
  throw new Error('fleet-restore-kill-worker requires restore paths, Postgres stubs, and a fault stage');
}
if (faultStage !== 'after_journal'
  && faultStage !== 'after_database_commit'
  && faultStage !== 'after_tree_publish'
  && faultStage !== 'after_rollback_marker_removal') {
  throw new Error(`Unsupported fleet restore fault stage: ${faultStage}`);
}
const publishedTreeCount = Number(rawPublishedTreeCount);
if (!Number.isSafeInteger(publishedTreeCount) || publishedTreeCount < 0) {
  throw new Error(`Invalid published tree count: ${rawPublishedTreeCount}`);
}

await restoreFleetCompanionSlice({
  fleetManifestPath,
  companionId,
  destinations: { companionDataDir, personalWorkspacePath },
  postgres: { databaseUrl, pgRestoreBinary, psqlBinary },
  projectionLifecycle: {
    invalidate: async () => undefined,
    backfill: async () => undefined,
  },
  faultInjection: (stage: FleetRestoreFaultStage, count: number) => {
    if (faultStage === 'after_rollback_marker_removal') {
      if (stage === 'after_tree_publish' && count === 1) {
        mkdirSync(personalWorkspacePath, { recursive: true });
        writeFileSync(join(personalWorkspacePath, 'collision.txt'), 'concurrent owner\n');
        return;
      }
      if (stage === faultStage) process.kill(process.pid, 'SIGKILL');
      return;
    }
    if (stage === faultStage
      && (stage !== 'after_tree_publish' || count === publishedTreeCount)) {
      process.kill(process.pid, 'SIGKILL');
    }
  },
});

throw new Error('fleet restore kill worker unexpectedly survived its configured fault');
