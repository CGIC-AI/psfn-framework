import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { CogSecEventStore } from '../../core/cogsec/events.js';
import type { ShellExecParams } from './protocol.js';
import type {
  PersonaOwnerPathClass,
  PersonaOwnerPathRegistry,
} from './persona-owner-path-registry.js';
import {
  collectShellMutationTargets,
  type ShellMutationTarget,
} from './persona-shell-mutation-targets.js';

export type RawPersonaMutationTool = 'fs.write' | 'fs.edit' | 'shell.exec';

export interface PersonaMutationAttemptGuardCompanion {
  companionId: string;
  registry: PersonaOwnerPathRegistry;
  eventStore: Pick<CogSecEventStore, 'upsertEvent'>;
}

export interface PersonaMutationAttemptDetection {
  pathClass: PersonaOwnerPathClass;
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
