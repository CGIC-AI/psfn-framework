import type { HubStreamState } from './stream/hub-stream.js';

export type ArtifactCapabilityState = 'available' | 'unsupported';

export interface ArtifactShelfItem {
  id: string;
  label: string;
  mediaType: string;
  provenance: string;
  status: 'available' | 'denied' | 'expired';
}

export interface ArtifactShelfState {
  capability: ArtifactCapabilityState;
  items: ArtifactShelfItem[];
  blockedReason: string | null;
}

export const ARTIFACTS_UNSUPPORTED_REASON =
  'Satellite Hub protocol does not expose scoped artifact events or read access yet';

export function deriveArtifactShelfState(_stream: HubStreamState): ArtifactShelfState {
  return {
    capability: 'unsupported',
    items: [],
    blockedReason: ARTIFACTS_UNSUPPORTED_REASON,
  };
}

export function readArtifactPreview(): never {
  throw new Error(ARTIFACTS_UNSUPPORTED_REASON);
}
