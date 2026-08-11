import type { NotificationPort } from '../../boundary/gateway/notification-port.js';
import type { NotificationSenderMetadata } from '../../boundary/gateway/notification-sender.js';
import type { Attachment } from '../../shared/contracts/runtime.js';
import {
  artifactSensitivityRequiresApproval,
  fingerprintArtifactSensitivity,
  type ArtifactSensitivityClassification,
} from '../../shared/contracts/artifact-sensitivity.js';
import type {
  ApprovalQueuePort,
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
} from '../../system/capabilities/approval-queue-port.js';

const ARTIFACT_EGRESS_NOTIFICATION_SENDER = Object.freeze({
  kind: 'system',
  provenance: 'system.artifact_egress.approval',
} satisfies NotificationSenderMetadata);

export type ArtifactEgressAudience = 'self' | 'primary_contact' | 'external' | 'ambiguous';

export interface ArtifactEgressDestination {
  audience: ArtifactEgressAudience;
  channelId: string;
  channelType: string;
  surface: 'conversation' | 'public_channel' | 'satellite' | 'pwa' | 'external';
}

export interface ArtifactEgressApprovalDeps {
  approvalQueue?: ApprovalQueuePort | null;
  notifier?: NotificationPort | null;
  executeApprovedShare: (
    attachments: readonly Attachment[],
    destination: ArtifactEgressDestination,
  ) => Promise<void>;
  readCurrentClassifications: (
    attachments: readonly Attachment[],
  ) => Promise<readonly ArtifactSensitivityClassification[]>;
}

export type ArtifactEgressDecision =
  | { disposition: 'proceed'; attachments: Attachment[] }
  | {
      disposition: 'queued';
      attachments: [];
      queueEntry: ConfirmationQueueEntry;
      sensitivity: ArtifactSensitivityClassification['sensitivity'];
    }
  | {
      disposition: 'settled';
      attachments: [];
      queueEntryId: string;
      resolution: ConfirmationQueueHistoryEntry['status'];
      sensitivity: ArtifactSensitivityClassification['sensitivity'];
    };

function requireDestination(destination: ArtifactEgressDestination): ArtifactEgressDestination {
  const channelId = destination.channelId.trim();
  const channelType = destination.channelType.trim();
  if (!channelId || !channelType) {
    throw new Error('Artifact egress destination requires channelId and channelType');
  }
  return { ...destination, channelId, channelType };
}

function buildApprovalNotification(
  entry: ConfirmationQueueEntry,
  classification: ArtifactSensitivityClassification,
  destination: ArtifactEgressDestination,
): string {
  return [
    'A generated artifact share is waiting for your approval.',
    `Inherited sensitivity: ${classification.sensitivity}.`,
    `Destination: ${destination.surface} (${destination.channelType}).`,
    'The artifact itself is not included in this notification. Review it in Garden before deciding.',
    `Confirmation ID: ${entry.id}`,
  ].join('\n');
}

function assertClassificationsUnchanged(
  expectedFingerprint: string,
  classifications: readonly ArtifactSensitivityClassification[],
): void {
  if (classifications.length === 0) {
    throw new Error('Approved artifact share requires current sensitivity classification');
  }
  if (classifications.some(
    classification => fingerprintArtifactSensitivity(classification) !== expectedFingerprint,
  )) {
    throw new Error('Artifact sensitivity changed after approval was requested; request a new approval');
  }
}

function findMatchingPendingApproval(
  approvalQueue: ApprovalQueuePort,
  scope: string,
  params: Record<string, unknown>,
): ConfirmationQueueEntry | null {
  const serializedParams = JSON.stringify(params);
  return approvalQueue.listPending().find(entry => (
    entry.method === 'artifact.share'
    && entry.action === 'share'
    && entry.scope === scope
    && JSON.stringify(entry.params) === serializedParams
  )) ?? null;
}

function findMatchingSettledApproval(
  approvalQueue: ApprovalQueuePort,
  scope: string,
  params: Record<string, unknown>,
): ConfirmationQueueHistoryEntry | null {
  const serializedParams = JSON.stringify(params);
  return approvalQueue.listHistory().find(entry => (
    (entry.status === 'approved' || entry.status === 'denied' || entry.executed)
    && entry.method === 'artifact.share'
    && entry.action === 'share'
    && entry.scope === scope
    && JSON.stringify(entry.params) === serializedParams
  )) ?? null;
}

function requireSingleCurrentClassification(
  attachments: readonly Attachment[],
  classifications: readonly ArtifactSensitivityClassification[],
): ArtifactSensitivityClassification {
  if (classifications.length !== attachments.length || classifications.length === 0) {
    throw new Error('Recovered artifact egress requires current sensitivity classification for every attachment');
  }
  const classification = classifications[0];
  if (!classification) {
    throw new Error('Recovered artifact egress requires current sensitivity classification for every attachment');
  }
  const fingerprint = fingerprintArtifactSensitivity(classification);
  if (classifications.some(current => fingerprintArtifactSensitivity(current) !== fingerprint)) {
    throw new Error('Recovered artifact attachments have inconsistent current sensitivity classifications');
  }
  return classification;
}

interface ArtifactEgressAuthorizationInput {
  attachments: readonly Attachment[];
  classification: ArtifactSensitivityClassification;
  destination: ArtifactEgressDestination;
  deps: ArtifactEgressApprovalDeps;
}

async function authorizeArtifactEgressInternal(
  input: ArtifactEgressAuthorizationInput,
  reuseExistingApproval: boolean,
): Promise<ArtifactEgressDecision> {
  const attachments = input.attachments.map(attachment => ({ ...attachment }));
  if (attachments.length === 0) return { disposition: 'proceed', attachments };

  const destination = requireDestination(input.destination);
  if (destination.audience === 'self' || destination.audience === 'primary_contact') {
    return { disposition: 'proceed', attachments };
  }

  const requiresApproval = destination.audience === 'ambiguous'
    || artifactSensitivityRequiresApproval(input.classification);
  if (!requiresApproval) return { disposition: 'proceed', attachments };

  const approvalQueue = input.deps.approvalQueue;
  const notifier = input.deps.notifier;
  if (!approvalQueue || !notifier) {
    throw new Error('Sensitive artifact egress requires approval queue and notification wiring');
  }

  const classificationFingerprint = fingerprintArtifactSensitivity(input.classification);
  const currentClassifications = await input.deps.readCurrentClassifications(attachments);
  assertClassificationsUnchanged(classificationFingerprint, currentClassifications);
  const artifactRefs = attachments.map((attachment) => fingerprintArtifactSensitivity({
    ...input.classification,
    sources: [{
      ref: attachment.localPath?.trim() || attachment.url.trim(),
      sensitivity: input.classification.sensitivity,
    }],
  }));
  const queueParams: Record<string, unknown> = {
    artifactRefs,
    artifactCount: attachments.length,
    sensitivity: input.classification.sensitivity,
    classificationFingerprint,
    destination: {
      channelId: destination.channelId,
      channelType: destination.channelType,
      surface: destination.surface,
    },
  };
  const approvalScope = `${destination.surface}:${destination.channelType}:${destination.channelId}`;
  if (reuseExistingApproval) {
    const pendingEntry = findMatchingPendingApproval(approvalQueue, approvalScope, queueParams);
    if (pendingEntry) {
      return {
        disposition: 'queued',
        attachments: [],
        queueEntry: pendingEntry,
        sensitivity: input.classification.sensitivity,
      };
    }
    const settledEntry = findMatchingSettledApproval(approvalQueue, approvalScope, queueParams);
    if (settledEntry) {
      return {
        disposition: 'settled',
        attachments: [],
        queueEntryId: settledEntry.id,
        resolution: settledEntry.status,
        sensitivity: input.classification.sensitivity,
      };
    }
  }
  const entry = approvalQueue.enqueue({
    method: 'artifact.share',
    action: 'share',
    scope: approvalScope,
    params: queueParams,
    companionReason:
      `Sharing ${input.classification.sensitivity} artifact material beyond self or the primary contact requires review.`,
    resolutionAuthority: 'operator',
  }, async (approvedParams) => {
    if (JSON.stringify(approvedParams) !== JSON.stringify(queueParams)) {
      throw new Error('Artifact share approval parameters cannot be modified');
    }
    const current = await input.deps.readCurrentClassifications(attachments);
    assertClassificationsUnchanged(classificationFingerprint, current);
    await input.deps.executeApprovedShare(attachments, destination);
  });

  await notifier.notify({
    sender: ARTIFACT_EGRESS_NOTIFICATION_SENDER,
    title: 'Artifact share approval required',
    priority: 5,
    message: buildApprovalNotification(entry, input.classification, destination),
  });

  return {
    disposition: 'queued',
    attachments: [],
    queueEntry: entry,
    sensitivity: input.classification.sensitivity,
  };
}

export async function authorizeArtifactEgress(
  input: ArtifactEgressAuthorizationInput,
): Promise<ArtifactEgressDecision> {
  return authorizeArtifactEgressInternal(input, false);
}

/**
 * Recovery cannot trust the interrupted turn's context classification. External
 * release is re-authorized from the artifact sidecars as they exist now, while
 * self/operator delivery retains the direct-delivery policy of a normal turn.
 */
export async function authorizeRecoveredArtifactEgress(input: {
  attachments: readonly Attachment[];
  destination: ArtifactEgressDestination;
  deps: ArtifactEgressApprovalDeps;
}): Promise<ArtifactEgressDecision> {
  const attachments = input.attachments.map(attachment => ({ ...attachment }));
  if (attachments.length === 0) return { disposition: 'proceed', attachments };

  const destination = requireDestination(input.destination);
  if (destination.audience === 'self' || destination.audience === 'primary_contact') {
    return { disposition: 'proceed', attachments };
  }

  const currentClassifications = await input.deps.readCurrentClassifications(attachments);
  const classification = requireSingleCurrentClassification(attachments, currentClassifications);
  return authorizeArtifactEgressInternal({
    attachments,
    classification,
    destination,
    deps: input.deps,
  }, true);
}
