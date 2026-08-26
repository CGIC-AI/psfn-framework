import { EVALS_INPUT_PATTERNS, ROOT_TEST_FIXTURE_PATTERN, ROOT_RUNNABLE_TEST_PATTERN } from './change-scope-policy.mjs';

const ROOT_TEST_PATH_PATTERNS = [ROOT_RUNNABLE_TEST_PATTERN, ROOT_TEST_FIXTURE_PATTERN];

export const ROOT_BUILD_INPUTS = Object.freeze({
  include: [
    /^src\//,
    /^tests\/types\/companion-id\.type-test\.ts$/,
    /^package(?:-lock)?\.json$/,
    /^tsconfig[^/]*\.json$/,
    /^tsup\.config\.ts$/,
  ],
  exclude: ROOT_TEST_PATH_PATTERNS,
});

export const ROOT_TYPECHECK_INPUTS = Object.freeze({
  include: [
    /^src\//,
    /^tests\//,
    /^config\//,
    /^package(?:-lock)?\.json$/,
    /^tsconfig[^/]*\.json$/,
    /^scripts\/verify-typecheck-baseline\.mjs$/,
  ],
  exclude: ROOT_TEST_PATH_PATTERNS,
});

export const ROOT_TEST_INPUTS = Object.freeze({
  include: [
    /^src\//,
    /^tests\//,
    /^config\//,
    /^docker\//,
    /^models\//,
    /^resources\//,
    /^scripts\//,
    /^skills\//,
    /^README\.md$/,
    /^package(?:-lock)?\.json$/,
    /^tsconfig[^/]*\.json$/,
    /^vitest[^/]*\.[cm]?[jt]s$/,
  ],
});

export const SCRIPT_TEST_INPUTS = Object.freeze({
  include: [
    /^scripts\//,
    /^src\//,
    /^config\//,
    /^docker\//,
    /^package(?:-lock)?\.json$/,
    /^tsconfig[^/]*\.json$/,
    /^vitest[^/]*\.[cm]?[jt]s$/,
  ],
});

export const ROOT_LINT_INPUTS = Object.freeze({
  include: [
    /^(?:src|tests|scripts|admin-ui|companion-ui)\//,
    /^eslint\.config\.[cm]?[jt]s$/,
    /^package(?:-lock)?\.json$/,
    /^tsconfig[^/]*\.json$/,
  ],
});

export const SEMGREP_RULE_INPUTS = Object.freeze({
  include: [
    /^config\/semgrep\//,
    /^scripts\/ci\/run-semgrep\.sh$/,
    /^package(?:-lock)?\.json$/,
  ],
});

export const EVALS_INPUTS = Object.freeze({
  include: [
    ...EVALS_INPUT_PATTERNS,
    /^package\.json$/,
    /^scripts\/ci\/bootstrap-worktree\.mjs$/,
  ],
});

export function specialistInputs(projectPath, { rootSource = true } = {}) {
  const escapedProjectPath = projectPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return {
    include: [
      new RegExp(`^${escapedProjectPath}\\/`),
      ...(rootSource ? [/^src\//] : []),
      /^package\.json$/,
      /^scripts\/ci\/bootstrap-worktree\.mjs$/,
      /^scripts\/verify-knip-baseline\.mjs$/,
    ],
  };
}
