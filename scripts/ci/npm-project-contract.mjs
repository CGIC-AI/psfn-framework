export const NPM_PROJECT_PATHS = Object.freeze([
  '.',
  'admin-ui',
  'companion-ui',
  'apps/satellite-hub',
  'tools/evals',
]);

export const NPM_LOCKFILES = Object.freeze(NPM_PROJECT_PATHS.map((projectPath) => (
  projectPath === '.' ? 'package-lock.json' : `${projectPath}/package-lock.json`
)));
