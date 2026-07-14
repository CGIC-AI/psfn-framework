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
  && faultStage !== 'after_tree_publish') {
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
  faultInjection: (stage: FleetRestoreFaultStage, count: number) => {
    if (stage === faultStage
      && (stage !== 'after_tree_publish' || count === publishedTreeCount)) {
      process.kill(process.pid, 'SIGKILL');
    }
  },
});

throw new Error('fleet restore kill worker unexpectedly survived its configured fault');
