import { apiGet, apiPost } from '$lib/api/client';
import type {
  AdminIcpAutonomyData,
  AdminIcpMutationResult,
} from '../../../../../src/operator/garden/services/types.js';

export type IcpAutonomyData = AdminIcpAutonomyData;
export type IcpAutonomyMutationResult = AdminIcpMutationResult;

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
