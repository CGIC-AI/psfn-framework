import type { ArtifactLifecycleStatus } from '../../../../persistence/artifact-lifecycle/manager.js';

export interface AdminArtifactLifecycleService {
  getArtifactLifecycleData(): ArtifactLifecycleStatus;
}
