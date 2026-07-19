import { uniqueStrings } from '../../shared/utils/strings.js';
import type {
  CogSecAffectedArtifacts,
  CogSecArtifactClass,
} from './events.js';

export function mergeArtifactImpact(
  artifacts: CogSecAffectedArtifacts,
  artifactClass: CogSecArtifactClass,
  ids: readonly string[],
  count: number,
): void {
  const existing = artifacts[artifactClass];
  const mergedIds = uniqueStrings([
    ...(existing?.ids ?? []),
    ...ids,
  ]);
  artifacts[artifactClass] = {
    ids: mergedIds,
    count: Math.max(existing?.count ?? 0, mergedIds.length, count),
  };
}
