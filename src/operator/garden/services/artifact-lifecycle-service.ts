import { ArtifactLifecycleManager } from '../../../persistence/artifact-lifecycle/manager.js';
import { loadSchedulerConfig } from '../../../system/config/scheduler-config.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import { ResearchLibraryStore } from '../../../faculties/memory/research-library/store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type {
  AdminArtifactLifecycleService,
} from './types.js';

export class AdminArtifactLifecycleDataService implements AdminArtifactLifecycleService {
  constructor(private readonly deps: {
    config: SubstrateConfig;
    memoryStore: MemoryStorePort;
    companionDataDir: string;
    researchLibraryStore: ResearchLibraryStore;
  }) {}

  getArtifactLifecycleData() {
    // scheduler.json is a per-companion owner file (dnll.3): read it from the
    // companion data dir, not the shared system root.
    const schedulerConfig = loadSchedulerConfig(this.deps.companionDataDir);
    const manager = new ArtifactLifecycleManager({
      companionDataDir: this.deps.companionDataDir,
      workspacePath: typeof this.deps.config.workspacePath === 'string' ? this.deps.config.workspacePath : undefined,
      policy: schedulerConfig.artifactLifecycle,
      memoryStore: this.deps.memoryStore,
      researchLibraryStore: this.deps.researchLibraryStore,
    });
    return manager.getStatus();
  }
}
