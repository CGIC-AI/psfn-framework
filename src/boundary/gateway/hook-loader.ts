import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  type Dirent,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  HOOK_SUBSCRIBABLE_EVENTS,
  HookMatcher,
  HookRegistry,
  type HookLifecycleHandler,
  type HookSubscribableEventName,
} from './hook-registry.js';

/**
 * Workspace hook loader (bead vvf.2): scans
 * `WORKSPACE_PATH/hooks/` for `HOOK.yaml` manifests plus their handler
 * modules and registers validated hooks with the {@link HookRegistry},
 * mirroring the skills-faculty loader conventions
 * (`src/faculties/skills/loader.ts` scanning `skills/<name>/SKILL.md`).
 *
 * TRUST MODEL / SECURITY
 * Hooks are operator-authored code living in the companion's Personal
 * Workspace — the same trust level as workspace skills and modules. Loading a
 * hook dynamically imports its handler module in-process. This is currently
 * the ONLY path in the runtime that executes operator JS from disk (the
 * module registry's source execution is deliberately disabled in
 * `src/system/modules/loader.ts`); it exists here as the explicit,
 * bead-sanctioned Hermes hooks.py pattern and is bounded by fail-closed
 * validation:
 *  - manifests reject on unknown keys, unknown/non-allowlisted lifecycle
 *    events, unsupported invocation modes, and missing/escaping handlers;
 *  - handler paths must stay inside the hook's own directory (no absolute
 *    paths, no `..` escapes, no symlinked handler files);
 *  - a rejected hook is skipped with a logged reason — a bad hook file never
 *    crashes startup and is never silently half-loaded;
 *  - registered handlers receive redacted event data only (see
 *    hook-registry.ts) and no runtime capabilities.
 */

const HOOK_MANIFEST_FILE_NAME = 'HOOK.yaml';
/**
 * Workspace-relative directory the operator hook loader scans and dynamically
 * imports handler modules from. Exported so the gateway write-policy fence
 * (see {@link file://../bootstrap-input.ts} `protectedWritePaths`) can protect
 * the exact same directory the loader executes from — the fence and the loader
 * must never drift to different directory names, or a model-driven fs.write
 * could plant a handler module that runs with full Node privileges on the next
 * agent restart.
 */
export const HOOKS_DIRECTORY_NAME = 'hooks';
const ALLOWED_MANIFEST_KEYS = new Set([
  'name',
  'description',
  'events',
  'handler',
  'invocation',
  'enabled',
]);
const ALLOWED_HANDLER_EXTENSIONS = ['.mjs', '.cjs', '.js'];

const log = createComponentLogger('HookLoader');

export type HookRejectionKind =
  | 'scan_error'
  | 'parse_error'
  | 'invalid_manifest'
  | 'unknown_event'
  | 'unsupported_invocation'
  | 'missing_handler'
  | 'handler_load_error'
  | 'duplicate_name'
  | 'disabled'
  | 'registration_error';

export interface HookRejection {
  kind: HookRejectionKind;
  /** Manifest path relative to the hooks root (posix separators). */
  relativePath: string;
  /** Manifest-declared hook name when one parsed. */
  name?: string;
  reason: string;
}

export interface LoadedHookRecord {
  name: string;
  relativePath: string;
  events: readonly HookSubscribableEventName[];
}

export interface WorkspaceHookLoadResult {
  rootPath: string;
  rootExists: boolean;
  loaded: LoadedHookRecord[];
  rejected: HookRejection[];
}

export interface LoadWorkspaceHooksOptions {
  workspacePath: string;
  registry: HookRegistry;
  /** Override the handler module importer (tests). Defaults to dynamic import. */
  importModule?: (url: string) => Promise<unknown>;
  /** Override directory reads for deterministic filesystem-failure tests. */
  readDirectory?: (absolutePath: string) => Dirent[];
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

interface HookManifestCandidate {
  manifestAbsolutePath: string;
  hookDirAbsolutePath: string;
  relativePath: string;
}

/**
 * Walk an existing hooks root for HOOK.yaml files, skipping symlinks —
 * mirrors `walkSkillFiles` in the skills loader.
 */
function defaultReadDirectory(absolutePath: string): Dirent[] {
  return readdirSync(absolutePath, { withFileTypes: true });
}

function walkHookManifests(
  rootAbsolutePath: string,
  readDirectory: (absolutePath: string) => Dirent[] = defaultReadDirectory,
): HookManifestCandidate[] {
  const candidates: HookManifestCandidate[] = [];
  const stack = [rootAbsolutePath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = readDirectory(current);
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || entry.name !== HOOK_MANIFEST_FILE_NAME) continue;

      candidates.push({
        manifestAbsolutePath: absolutePath,
        hookDirAbsolutePath: current,
        relativePath: toPosix(relative(rootAbsolutePath, absolutePath)),
      });
    }
  }

  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return candidates;
}

interface ParsedHookManifest {
  name: string;
  description?: string;
  eventPatterns: string[];
  handler: string;
  enabled: boolean;
}

class ManifestValidationError extends Error {
  constructor(
    readonly kind: Extract<HookRejectionKind,
      'invalid_manifest' | 'unknown_event' | 'unsupported_invocation' | 'missing_handler'>,
    message: string,
    readonly hookName?: string,
  ) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

function parseManifest(raw: unknown, relativePath: string): ParsedHookManifest {
  if (!isRecord(raw)) {
    throw new ManifestValidationError(
      'invalid_manifest',
      `${relativePath}: manifest must be a YAML mapping`,
    );
  }

  const unknownKeys = Object.keys(raw).filter(key => !ALLOWED_MANIFEST_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new ManifestValidationError(
      'invalid_manifest',
      `${relativePath}: unknown manifest keys: ${unknownKeys.join(', ')} `
        + `(allowed: ${[...ALLOWED_MANIFEST_KEYS].join(', ')})`,
    );
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    throw new ManifestValidationError(
      'invalid_manifest',
      `${relativePath}: "name" is required and must be a non-empty string`,
    );
  }

  if (raw.description !== undefined && typeof raw.description !== 'string') {
    throw new ManifestValidationError(
      'invalid_manifest',
      `${relativePath}: "description" must be a string`,
      name,
    );
  }

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new ManifestValidationError(
      'invalid_manifest',
      `${relativePath}: "enabled" must be a boolean`,
      name,
    );
  }
  const enabled = raw.enabled !== false;

  if (raw.invocation !== undefined && raw.invocation !== 'async_lifecycle') {
    if (raw.invocation === 'sync_decision') {
      throw new ManifestValidationError(
        'unsupported_invocation',
        `${relativePath}: invocation "sync_decision" is not supported yet `
          + '(synchronous pre-tool hooks land with bead 7ym.3)',
        name,
      );
    }
    throw new ManifestValidationError(
      'unsupported_invocation',
      `${relativePath}: unknown invocation "${String(raw.invocation)}" (supported: async_lifecycle)`,
      name,
    );
  }

  if (!Array.isArray(raw.events)
    || raw.events.length === 0
    || !raw.events.every((event): event is string => typeof event === 'string')) {
    throw new ManifestValidationError(
      'invalid_manifest',
      `${relativePath}: "events" must be a non-empty array of event-name strings`,
      name,
    );
  }

  const handler = typeof raw.handler === 'string' ? raw.handler.trim() : '';
  if (!handler) {
    throw new ManifestValidationError(
      'missing_handler',
      `${relativePath}: "handler" is required and must name a module file in the hook directory`,
      name,
    );
  }

  return {
    name,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    eventPatterns: raw.events,
    handler,
    enabled,
  };
}

function resolveHandlerPath(
  manifest: ParsedHookManifest,
  candidate: HookManifestCandidate,
): string {
  const { handler } = manifest;
  if (isAbsolute(handler)) {
    throw new ManifestValidationError(
      'missing_handler',
      `${candidate.relativePath}: handler path must be relative to the hook directory`,
      manifest.name,
    );
  }

  const resolved = resolve(candidate.hookDirAbsolutePath, handler);
  const contained = relative(candidate.hookDirAbsolutePath, resolved);
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) {
    throw new ManifestValidationError(
      'missing_handler',
      `${candidate.relativePath}: handler path escapes the hook directory: "${handler}"`,
      manifest.name,
    );
  }

  if (!ALLOWED_HANDLER_EXTENSIONS.some(extension => resolved.endsWith(extension))) {
    throw new ManifestValidationError(
      'missing_handler',
      `${candidate.relativePath}: handler must be a ${ALLOWED_HANDLER_EXTENSIONS.join('/')} module`,
      manifest.name,
    );
  }

  if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
    throw new ManifestValidationError(
      'missing_handler',
      `${candidate.relativePath}: handler file not found (or not a regular file): "${handler}"`,
      manifest.name,
    );
  }

  return resolved;
}

function resolveHandlerExport(moduleExports: unknown, relativePath: string): HookLifecycleHandler {
  if (isRecord(moduleExports)) {
    if (typeof moduleExports.default === 'function') {
      return moduleExports.default as HookLifecycleHandler;
    }
    if (typeof moduleExports.handler === 'function') {
      return moduleExports.handler as HookLifecycleHandler;
    }
  }
  throw new Error(
    `${relativePath}: handler module must export a function as "default" or "handler"`,
  );
}

function expandEventPatterns(
  manifest: ParsedHookManifest,
  relativePath: string,
): HookSubscribableEventName[] {
  const patternErrors = HookMatcher.validatePatterns(manifest.eventPatterns);
  if (patternErrors.length > 0) {
    throw new ManifestValidationError(
      'invalid_manifest',
      `${relativePath}: ${patternErrors.join('; ')}`,
      manifest.name,
    );
  }

  const matcher = new HookMatcher(manifest.eventPatterns);
  const { matched, unmatchedPatterns } = matcher.expand(HOOK_SUBSCRIBABLE_EVENTS);
  if (unmatchedPatterns.length > 0) {
    throw new ManifestValidationError(
      'unknown_event',
      `${relativePath}: events not in the subscribable allowlist: `
        + `${unmatchedPatterns.join(', ')} `
        + `(subscribable: ${HOOK_SUBSCRIBABLE_EVENTS.join(', ')})`,
      manifest.name,
    );
  }
  return matched as HookSubscribableEventName[];
}

async function defaultImportModule(url: string): Promise<unknown> {
  return await import(url);
}

/**
 * Scan `<workspacePath>/hooks/` and register every valid hook. Never throws
 * for a bad hook definition: each invalid entry becomes a rejected-with-reason
 * record and a WARN log, and startup continues. An absent hooks directory is
 * a clean no-op.
 */
export async function loadWorkspaceHooks(
  options: LoadWorkspaceHooksOptions,
): Promise<WorkspaceHookLoadResult> {
  const workspacePath = options.workspacePath.trim();
  if (!workspacePath) {
    throw new Error('loadWorkspaceHooks requires an explicit workspacePath');
  }
  const importModule = options.importModule ?? defaultImportModule;
  const rootPath = resolve(workspacePath, HOOKS_DIRECTORY_NAME);

  const rootExists = existsSync(rootPath) && lstatSync(rootPath).isDirectory();
  if (!rootExists) {
    log.debug('No workspace hooks directory; operator hook system idle', { rootPath });
    return { rootPath, rootExists: false, loaded: [], rejected: [] };
  }

  const loaded: LoadedHookRecord[] = [];
  const rejected: HookRejection[] = [];
  const seenNames = new Map<string, string>();

  let candidates: HookManifestCandidate[] = [];
  try {
    candidates = walkHookManifests(
      rootPath,
      options.readDirectory ?? defaultReadDirectory,
    );
  } catch (error) {
    rejected.push({
      kind: 'scan_error',
      relativePath: '.',
      reason: `workspace hooks directory scan failed: ${toErrorMessage(error)}`,
    });
  }

  for (const candidate of candidates) {
    let manifestName: string | undefined;
    try {
      const document = readFileSync(candidate.manifestAbsolutePath, 'utf-8');
      let rawManifest: unknown;
      try {
        rawManifest = parseYaml(document);
      } catch (error) {
        rejected.push({
          kind: 'parse_error',
          relativePath: candidate.relativePath,
          reason: `${candidate.relativePath}: invalid YAML: ${toErrorMessage(error)}`,
        });
        continue;
      }

      const manifest = parseManifest(rawManifest, candidate.relativePath);
      manifestName = manifest.name;

      if (!manifest.enabled) {
        rejected.push({
          kind: 'disabled',
          relativePath: candidate.relativePath,
          name: manifest.name,
          reason: `${candidate.relativePath}: disabled by manifest (enabled: false)`,
        });
        continue;
      }

      const existing = seenNames.get(manifest.name);
      if (existing) {
        rejected.push({
          kind: 'duplicate_name',
          relativePath: candidate.relativePath,
          name: manifest.name,
          reason: `${candidate.relativePath}: duplicate hook name "${manifest.name}" `
            + `(already loaded from ${existing})`,
        });
        continue;
      }

      const events = expandEventPatterns(manifest, candidate.relativePath);
      const handlerAbsolutePath = resolveHandlerPath(manifest, candidate);

      let handler: HookLifecycleHandler;
      try {
        const moduleExports = await importModule(pathToFileURL(handlerAbsolutePath).href);
        handler = resolveHandlerExport(moduleExports, candidate.relativePath);
      } catch (error) {
        rejected.push({
          kind: 'handler_load_error',
          relativePath: candidate.relativePath,
          name: manifest.name,
          reason: `${candidate.relativePath}: failed to load handler: ${toErrorMessage(error)}`,
        });
        continue;
      }

      try {
        options.registry.register({
          mode: 'async_lifecycle',
          name: manifest.name,
          ...(manifest.description !== undefined ? { description: manifest.description } : {}),
          sourcePath: candidate.manifestAbsolutePath,
          events,
          handler,
        });
      } catch (error) {
        rejected.push({
          kind: 'registration_error',
          relativePath: candidate.relativePath,
          name: manifest.name,
          reason: `${candidate.relativePath}: ${toErrorMessage(error)}`,
        });
        continue;
      }

      seenNames.set(manifest.name, candidate.relativePath);
      loaded.push({ name: manifest.name, relativePath: candidate.relativePath, events });
    } catch (error) {
      if (error instanceof ManifestValidationError) {
        rejected.push({
          kind: error.kind,
          relativePath: candidate.relativePath,
          ...(error.hookName !== undefined ? { name: error.hookName } : {}),
          reason: error.message,
        });
        continue;
      }
      // Unexpected per-hook failure (fs race, etc.): reject the hook loudly,
      // never crash startup.
      rejected.push({
        kind: 'invalid_manifest',
        relativePath: candidate.relativePath,
        ...(manifestName !== undefined ? { name: manifestName } : {}),
        reason: `${candidate.relativePath}: ${toErrorMessage(error)}`,
      });
    }
  }

  for (const rejection of rejected) {
    log.warn('Rejected workspace hook', {
      kind: rejection.kind,
      relativePath: rejection.relativePath,
      ...(rejection.name !== undefined ? { name: rejection.name } : {}),
      reason: rejection.reason,
    });
  }
  log.info('Workspace hook scan complete', {
    rootPath,
    loadedCount: loaded.length,
    rejectedCount: rejected.length,
    loaded: loaded.map(record => record.name),
  });

  return { rootPath, rootExists: true, loaded, rejected };
}
