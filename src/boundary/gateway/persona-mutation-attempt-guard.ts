import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import type { CogSecEventStore } from '../../core/cogsec/events.js';
import type { ShellExecParams } from './protocol.js';
import type {
  PersonaOwnerPathClass,
  PersonaOwnerPathRegistry,
} from './persona-owner-path-registry.js';

export type RawPersonaMutationTool = 'fs.write' | 'fs.edit' | 'shell.exec';

export interface PersonaMutationAttemptGuardCompanion {
  companionId: string;
  registry: PersonaOwnerPathRegistry;
  eventStore: Pick<CogSecEventStore, 'upsertEvent'>;
}

export interface PersonaMutationAttemptDetection {
  pathClass: PersonaOwnerPathClass;
}

interface ShellMutationTarget {
  path: string;
  includeOwnerContainers: boolean;
}

type ShellToken =
  | { kind: 'word'; value: string }
  | { kind: 'separator' }
  | { kind: 'output_redirect' }
  | { kind: 'input_redirect' };

function tokenizeShellScript(script: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let quote: 'single' | 'double' | null = null;
  const flushWord = (): void => {
    if (!word) return;
    tokens.push({ kind: 'word', value: word });
    word = '';
  };

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (quote === 'single') {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else if (char === '\\' && index + 1 < script.length) word += script[++index];
      else word += char;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (char === '\\' && index + 1 < script.length) {
      word += script[++index];
      continue;
    }
    if (/\s/u.test(char)) {
      flushWord();
      continue;
    }
    if (char === ';' || char === '|'
      || (char === '&' && script[index + 1] === '&')) {
      flushWord();
      if (script[index + 1] === char) index += 1;
      tokens.push({ kind: 'separator' });
      continue;
    }
    if (char === '>') {
      flushWord();
      if (script[index + 1] === '>') index += 1;
      tokens.push({ kind: 'output_redirect' });
      continue;
    }
    if (char === '<') {
      flushWord();
      while (script[index + 1] === '<') index += 1;
      tokens.push({ kind: 'input_redirect' });
      continue;
    }
    word += char;
  }
  flushWord();
  return tokens;
}

function resolveTargetPath(rawPath: string, cwd: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('$')) return null;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

function positionalArgs(args: readonly string[]): string[] {
  const positional: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) continue;
    positional.push(arg);
  }
  return positional;
}

function resolvedTargets(
  values: readonly string[],
  cwd: string,
  includeOwnerContainers: boolean,
): ShellMutationTarget[] {
  return values.flatMap((value) => {
    const path = resolveTargetPath(value, cwd);
    return path ? [{ path, includeOwnerContainers }] : [];
  });
}

function collectCommandMutationTargets(
  commandValue: string,
  args: readonly string[],
  cwd: string,
): ShellMutationTarget[] {
  const command = basename(commandValue).toLowerCase();
  const positional = positionalArgs(args);
  switch (command) {
    case 'rm':
    case 'unlink':
    case 'rmdir':
      return resolvedTargets(positional, cwd, true);
    case 'mv':
    case 'ln':
      return resolvedTargets(positional, cwd, true);
    case 'cp':
    case 'install':
      return resolvedTargets(positional.length > 0 ? [positional.at(-1)!] : [], cwd, true);
    case 'tee':
    case 'touch':
      return resolvedTargets(positional, cwd, false);
    case 'truncate':
      return resolvedTargets(positional.length > 0 ? [positional.at(-1)!] : [], cwd, false);
    case 'sed':
      return args.some(arg => arg === '-i' || arg.startsWith('-i'))
        ? resolvedTargets(positional.length > 1 ? positional.slice(1) : [], cwd, false)
        : [];
    case 'dd':
      return resolvedTargets(
        args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice('of='.length)),
        cwd,
        false,
      );
    default:
      return [];
  }
}

function collectScriptMutationTargets(script: string, cwd: string): ShellMutationTarget[] {
  const targets: ShellMutationTarget[] = [];
  let words: string[] = [];
  let awaitingRedirect: 'output' | 'input' | null = null;
  const flushCommand = (): void => {
    if (words.length > 0) targets.push(...collectCommandMutationTargets(words[0], words.slice(1), cwd));
    words = [];
  };

  for (const token of tokenizeShellScript(script)) {
    if (token.kind === 'separator') {
      flushCommand();
      awaitingRedirect = null;
      continue;
    }
    if (token.kind === 'output_redirect') {
      awaitingRedirect = 'output';
      continue;
    }
    if (token.kind === 'input_redirect') {
      awaitingRedirect = 'input';
      continue;
    }
    if (awaitingRedirect) {
      if (awaitingRedirect === 'output') {
        targets.push(...resolvedTargets([token.value], cwd, false));
      }
      awaitingRedirect = null;
      continue;
    }
    words.push(token.value);
  }
  flushCommand();
  return targets;
}

function collectShellMutationTargets(params: ShellExecParams, workspacePath: string): ShellMutationTarget[] {
  const requestedCwd = typeof params.cwd === 'string' && params.cwd.trim()
    ? params.cwd.trim()
    : workspacePath;
  const cwd = isAbsolute(requestedCwd) ? resolve(requestedCwd) : resolve(workspacePath, requestedCwd);
  const args = Array.isArray(params.args) ? params.args : [];
  const command = basename(params.command).toLowerCase();
  const shellCommandIndex = (command === 'bash' || command === 'sh' || command === 'dash')
    ? args.findIndex(arg => arg === '-c' || arg === '-lc')
    : -1;
  if (shellCommandIndex >= 0 && typeof args[shellCommandIndex + 1] === 'string') {
    return collectScriptMutationTargets(args[shellCommandIndex + 1], cwd);
  }
  return collectCommandMutationTargets(params.command, args, cwd);
}

function safeSummary(tool: RawPersonaMutationTool, pathClass: PersonaOwnerPathClass, count: number): string {
  return `Blocked direct ${tool} mutation against protected ${pathClass} identity data; `
    + `${String(count)} correlated occurrence${count === 1 ? '' : 's'} recorded. `
    + 'Use the governed identity tool for persona or prompt-layer changes.';
}

function correlationCaseId(
  companionId: string,
  tool: RawPersonaMutationTool,
  pathClass: PersonaOwnerPathClass,
): string {
  const digest = createHash('sha256')
    .update(`${companionId}\0${tool}\0${pathClass}`)
    .digest('hex')
    .slice(0, 24);
  return `cogsec_persona_mutation_${digest}`;
}

export class PersonaMutationAttemptGuard {
  private readonly companions = new Map<string, PersonaMutationAttemptGuardCompanion>();

  constructor(input: { companions: readonly PersonaMutationAttemptGuardCompanion[] }) {
    if (input.companions.length === 0) {
      throw new Error('Persona mutation attempt guard requires at least one companion owner registry');
    }
    for (const companion of input.companions) {
      const companionId = companion.companionId.trim();
      if (!companionId || this.companions.has(companionId)) {
        throw new Error(`Persona mutation attempt guard has invalid or duplicate companion ${companionId}`);
      }
      this.companions.set(companionId, { ...companion, companionId });
    }
  }

  isLegitimateMutationTool(tool: string): boolean {
    return tool === 'identity.update_persona';
  }

  inspectFilesystemMutation(input: {
    companionId: string;
    tool: 'fs.write' | 'fs.edit';
    requestedPath: string;
    workspacePath: string;
  }): PersonaMutationAttemptDetection[] {
    const target = isAbsolute(input.requestedPath)
      ? resolve(input.requestedPath)
      : resolve(input.workspacePath, input.requestedPath);
    return this.inspectTargets(input.companionId, input.tool, [{
      path: target,
      includeOwnerContainers: false,
    }]);
  }

  inspectShellMutation(input: {
    companionId: string;
    params: ShellExecParams;
    workspacePath: string;
  }): PersonaMutationAttemptDetection[] {
    return this.inspectTargets(
      input.companionId,
      'shell.exec',
      collectShellMutationTargets(input.params, input.workspacePath),
    );
  }

  private inspectTargets(
    companionIdValue: string,
    tool: RawPersonaMutationTool,
    targets: readonly ShellMutationTarget[],
  ): PersonaMutationAttemptDetection[] {
    const companionId = companionIdValue.trim();
    const companion = this.companions.get(companionId);
    if (!companion) {
      throw new Error('Persona mutation attempt guard cannot resolve the authenticated companion owner');
    }
    const pathClasses = new Set<PersonaOwnerPathClass>();
    for (const target of targets) {
      const classification = companion.registry.classifyMutationTarget(target.path, {
        includeOwnerContainers: target.includeOwnerContainers,
      });
      if (classification) pathClasses.add(classification.pathClass);
    }
    for (const pathClass of pathClasses) {
      this.recordAttempt(companion, tool, pathClass);
    }
    return [...pathClasses].map(pathClass => ({ pathClass }));
  }

  private recordAttempt(
    companion: PersonaMutationAttemptGuardCompanion,
    tool: RawPersonaMutationTool,
    pathClass: PersonaOwnerPathClass,
  ): void {
    const caseId = correlationCaseId(companion.companionId, tool, pathClass);
    companion.eventStore.upsertEvent({
      caseId,
      type: 'persona_mutation_bypass',
      severity: 'high',
      sourceChannelId: `tool:${tool}`,
      actor: `companion:${companion.companionId}`,
      affectedArtifacts: {
        persona_artifacts: { ids: [pathClass], count: 1 },
      },
      safeAgentSummary: safeSummary(tool, pathClass, 1),
    }, existing => {
      const previousCount = existing.affectedArtifacts.persona_artifacts?.count ?? 0;
      const nextCount = previousCount + 1;
      return {
        affectedArtifacts: {
          ...existing.affectedArtifacts,
          persona_artifacts: { ids: [pathClass], count: nextCount },
        },
        safeAgentSummary: safeSummary(tool, pathClass, nextCount),
      };
    });
  }
}
