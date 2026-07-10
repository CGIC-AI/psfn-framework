import type {
  ArtifactPreviewStreamState,
  ArtifactStreamItem,
  HubStreamState,
} from './stream/hub-stream.js';

export type ArtifactCapabilityState = 'available' | 'unsupported';

export type ArtifactPreviewViewState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'denied'
  | 'expired'
  | 'error'
  | 'unavailable';

export interface ArtifactPreviewView {
  state: ArtifactPreviewViewState;
  mediaType?: string;
  /** base64-encoded preview payload, present only when state is 'ready' */
  data?: string;
  message?: string;
}

export interface ArtifactShelfItem {
  id: string;
  label: string;
  mediaType: string;
  provenance: string;
  createdAt: string;
  previewable: boolean;
  preview: ArtifactPreviewView;
}

export interface ArtifactShelfState {
  capability: ArtifactCapabilityState;
  items: ArtifactShelfItem[];
  blockedReason: string | null;
}

/** Transport able to request a scoped artifact preview from the hub. */
export interface ArtifactPreviewTransport {
  requestArtifactPreview(artifactId: string): void;
}

export const ARTIFACTS_UNSUPPORTED_REASON =
  'Satellite Hub session has not acknowledged the artifact output capability';

export const ARTIFACT_PREVIEW_NOT_PREVIEWABLE_REASON =
  'Artifact is not previewable over the scoped hub read path';

/**
 * Artifacts are only shown once the hub has acked our `artifact` output
 * capability on this session; otherwise the shelf stays fail-closed.
 */
export function artifactCapabilityAcked(stream: HubStreamState): boolean {
  return stream.session?.capabilities?.output?.includes('artifact') ?? false;
}

export function deriveArtifactShelfState(stream: HubStreamState): ArtifactShelfState {
  if (!artifactCapabilityAcked(stream)) {
    return {
      capability: 'unsupported',
      items: [],
      blockedReason: ARTIFACTS_UNSUPPORTED_REASON,
    };
  }
  return {
    capability: 'available',
    items: stream.artifacts.map((item) => toShelfItem(item, stream.artifactPreviews[item.id])),
    blockedReason: null,
  };
}

/**
 * Request a preview for a shelf item. Fails closed when the capability is not
 * acked, or when the artifact declared itself non-previewable (in which case
 * the client never attempts a fetch).
 */
export function readArtifactPreview(
  transport: ArtifactPreviewTransport,
  stream: HubStreamState,
  artifactId: string,
): void {
  if (!artifactCapabilityAcked(stream)) {
    throw new Error(ARTIFACTS_UNSUPPORTED_REASON);
  }
  const artifact = stream.artifacts.find((item) => item.id === artifactId);
  if (!artifact) {
    throw new Error(`Unknown artifact: ${artifactId}`);
  }
  if (!artifact.previewable) {
    throw new Error(ARTIFACT_PREVIEW_NOT_PREVIEWABLE_REASON);
  }
  transport.requestArtifactPreview(artifactId);
}

function toShelfItem(
  item: ArtifactStreamItem,
  preview: ArtifactPreviewStreamState | undefined,
): ArtifactShelfItem {
  return {
    id: item.id,
    label: item.label,
    mediaType: item.mediaType,
    provenance: item.provenance,
    createdAt: item.createdAt,
    previewable: item.previewable,
    preview: toPreviewView(item, preview),
  };
}

function toPreviewView(
  item: ArtifactStreamItem,
  preview: ArtifactPreviewStreamState | undefined,
): ArtifactPreviewView {
  if (!item.previewable) {
    return { state: 'unavailable', message: ARTIFACT_PREVIEW_NOT_PREVIEWABLE_REASON };
  }
  if (!preview) {
    return { state: 'idle' };
  }
  return {
    state: preview.status,
    mediaType: preview.mediaType,
    data: preview.data,
    message: preview.message,
  };
}
