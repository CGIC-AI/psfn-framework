import type {
  AutomataRunRecord,
  EffectiveAutomataClassDescriptor,
} from '../../../faculties/automata/registry-contract.js';
import type { AutomataRunRegistry } from '../../../faculties/automata/run-registry.js';

export interface AdminAutomataSnapshot {
  classes: EffectiveAutomataClassDescriptor[];
  runs: AutomataRunRecord[];
}

export interface AdminAutomataService {
  getSnapshot(options?: {
    status?: string;
    classId?: string;
    taskId?: string;
    limit?: number;
  }): AdminAutomataSnapshot;
}

export class AdminAutomataDataService implements AdminAutomataService {
  constructor(private readonly registry: AutomataRunRegistry) {}

  getSnapshot(options: Parameters<AdminAutomataService['getSnapshot']>[0] = {}): AdminAutomataSnapshot {
    return {
      classes: this.registry.listClasses(),
      runs: this.registry.listRuns(options),
    };
  }
}
