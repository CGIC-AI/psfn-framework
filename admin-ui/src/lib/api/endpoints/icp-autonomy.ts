import { apiGet, apiPost } from '$lib/api/client';
import type {
  AdminIcpAutonomyData,
  AdminIcpMutationResult,
} from '../../../../../src/operator/garden/services/types.js';
import type {
  AdminIcpReadmitResult,
} from '../../../../../src/operator/garden/services/types/icp-autonomy.js';

export type IcpAutonomyData = AdminIcpAutonomyData;
export type IcpAutonomyMutationResult = AdminIcpMutationResult;
export type IcpAutonomyReadmitResult = AdminIcpReadmitResult;

const PATH = '/api/admin/icp-autonomy';

export function getIcpAutonomyData(): Promise<IcpAutonomyData> {
  return apiGet<IcpAutonomyData>(PATH);
}

export function cancelIcpCandidate(
  candidateId: string,
  expectedRevision: number,
): Promise<IcpAutonomyMutationResult> {
  return apiPost<IcpAutonomyMutationResult>(
    `${PATH}/candidates/${encodeURIComponent(candidateId)}/cancel`,
    { expectedRevision },
  );
}

export function setIcpDoNotDisturb(): Promise<IcpAutonomyMutationResult> {
  return apiPost<IcpAutonomyMutationResult>(`${PATH}/do-not-disturb`, {});
}

export function emergencyDisableIcpAutonomy(): Promise<IcpAutonomyMutationResult> {
  return apiPost<IcpAutonomyMutationResult>(`${PATH}/emergency-disable`, {});
}

/**
 * Explicitly readmit a lifecycle-fenced companion (psfn-framework-2vd7s).
 *
 * `confirmCompanionId` echoes the target: the Garden operator states which
 * companion they mean, so a blind body can never clear a durable admission
 * fence. The gateway still refuses a companion that is absent from the current
 * companions.json manifest.
 */
export function readmitIcpCompanion(companionId: string): Promise<IcpAutonomyReadmitResult> {
  return apiPost<IcpAutonomyReadmitResult>(`${PATH}/lifecycle/readmit`, {
    companionId,
    confirmCompanionId: companionId,
  });
}
