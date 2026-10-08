import {
  isRootTestPath,
  isRootTestFixturePath,
  isRunnableRootTestPath,
  ROOT_RUNNABLE_TEST_PATTERN,
} from './change-scope-policy.mjs';

const COMPANION_ID_TYPE_CONTRACT_PATTERN = /^(?:tests\/types\/companion-id\.type-test\.ts|tsconfig\.companion-id-types\.json)$/;
const ROOT_INTEGRATION_RISK_PATTERN = /^(?:src\/(?:app\/(?:e2e|startup)\/|boundary\/gateway\/|core\/(?:agent\/(?:arbiter|background-work)\/|contacts\/postgres-adapter|eval\/observer-sidecar\/)|faculties\/(?:automata|introspection|memory|wiki)\/|operator\/garden\/routes\/|persistence\/|system\/config\/|test-support\/)|vitest[^/]*\.[cm]?[jt]s$|package-lock\.json$)/;

function isGeneralRootTsconfig(path) {
  return /^tsconfig[^/]*\.json$/.test(path) && path !== 'tsconfig.companion-id-types.json';
}

export function buildRootValidationScope({ paths, fullRoot }) {
  const changedRootTests = paths.filter(isRunnableRootTestPath);
  const changedRootTestFixtures = paths.filter(isRootTestFixturePath);
  const rootProductSource = paths.some((path) => /^src\//.test(path) && !isRootTestPath(path));
  const rootScriptSource = paths.some((path) => /^scripts\/(?!ci\/)/.test(path) && !isRootTestPath(path));
  const packageLock = paths.includes('package-lock.json');
  const rootTypecheck = fullRoot || rootProductSource || packageLock
    || paths.some((path) => /^tests\//.test(path) || isGeneralRootTsconfig(path));
  const rootRuntimeBuild = !fullRoot && (
    rootProductSource || packageLock || paths.some(isGeneralRootTsconfig)
  );
  const rootProductTests = !fullRoot && rootProductSource;
  const rootScriptTests = !fullRoot && rootScriptSource;
  const rootIntegrationTests = rootProductTests && paths.some((path) => (
    ROOT_INTEGRATION_RISK_PATTERN.test(path)
  ));
  const runtimeJourneys = fullRoot || paths.some((path) => (
    !isRootTestPath(path)
    && (!ROOT_RUNNABLE_TEST_PATTERN.test(path) || /^companion-ui\/(?:e2e|runtime-e2e)\//.test(path))
    && /^(?:src\/|docker\/|companion-ui\/(?:(?:src|public|e2e|runtime-e2e)\/|(?:playwright[^/]*\.config\.ts|vite\.config\.ts|package(?:-lock)?\.json)$)|apps\/satellite-hub\/|scripts\/(?:smoke-docker(?:\/|[^/]*\.)|compose-(?:hub-)?verification\.|ops\/psfn-compose-smoke-)|package(?:-lock)?\.json$)/.test(path)
  ));

  return {
    changedRootTestFixtures,
    changedRootTests,
    companionIdTypes: paths.some((path) => COMPANION_ID_TYPE_CONTRACT_PATTERN.test(path)),
    rootIntegrationTests,
    rootProductTests,
    rootRuntimeBuild,
    rootScriptTests,
    rootTypecheck,
    runtimeJourneys,
  };
}
