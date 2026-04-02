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
    const schedulerConfig = loadSchedulerConfig(this.deps.config.dataDir);
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
