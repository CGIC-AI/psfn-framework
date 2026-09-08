import {
  deriveRoomDisclosureDestination,
  egressContentSha256,
  evaluateEgressCustodyHold,
  type ChannelDisclosureResolver,
  type EgressCustodyHoldReason,
  type EgressDeliveryRecorder,
  type TurnEgressCustodyProof,
} from '../cogsec/disclosure/index.js';
import { canonicalJsonString } from '../../shared/utils/json-serialization.js';
import { createComponentLogger } from '../../shared/logger.js';
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

const log = createComponentLogger('artifact-sensitivity-egress');

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

/**
 * Chain-of-custody wiring for artifact egress (psfn-framework-ccgdz.6). Absent,
 * no delivery record is written and the hold stays inert — behaviour is exactly
 * what it was before this bead.
 */
export interface ArtifactEgressCustodyDeps {
  recorder: EgressDeliveryRecorder;
  /** The turn that produced these artifacts; the delivery record's key. */
  turnId: string;
  /** The turn's durable custody proof; undefined ⇒ no chain to cite. */
  proof: TurnEgressCustodyProof | undefined;
  /** Classifies the destination channel into its disclosure destination. */
  resolveChannel: ChannelDisclosureResolver;
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
  custody?: ArtifactEgressCustodyDeps | null;
}

export type ArtifactEgressDecision =
  | { disposition: 'proceed'; attachments: Attachment[] }
  | {
      /**
       * Held by the fail-closed provenance rule (psfn-framework-ccgdz.6): the
       * artifacts were bound for an outward audience with an incomplete chain
       * of custody, so nothing was released and nothing was queued for review.
       */
      disposition: 'held';
      attachments: [];
      holdReason: EgressCustodyHoldReason;
    }
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


/**
 * Content-free identity of an artifact payload: the sorted list of each
 * attachment's declared name, media type, and storage reference, canonicalized
 * and hashed. It is a join key for "were these exact files released?", never
 * the bytes and never a path in the clear.
 */
function artifactPayloadSha256(attachments: readonly Attachment[]): string {
  const identities = attachments
    .map(attachment => ({
      name: attachment.name,
      contentType: attachment.contentType,
      ref: attachment.localPath?.trim() || attachment.url.trim(),
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  return egressContentSha256(canonicalJsonString(identities, 'artifact egress payload'));
}

/**
 * Fail-closed provenance hold for outward artifact egress
 * (psfn-framework-ccgdz.6). Called only AFTER the self/primary-contact early
 * return, so every egress reaching it is outward by audience even when the
 * destination channel does not classify into a room kind — an unresolvable
 * outward channel requires proof rather than escaping the gate.
 *
 * Writes the delivery record either way. Only the custody-durability reasons
 * honour the enforcement posture; `shadow` observes them and releases.
 */
async function holdArtifactEgressWithoutCustody(input: {
  attachments: readonly Attachment[];
  destination: ArtifactEgressDestination;
  custody: ArtifactEgressCustodyDeps;
}): Promise<{ disposition: 'held'; attachments: []; holdReason: EgressCustodyHoldReason } | null> {
  const { custody } = input;
  const destination = deriveRoomDisclosureDestination(
    input.destination.channelId,
    custody.resolveChannel,
  );
  const reason = evaluateEgressCustodyHold({
    destination,
    proof: custody.proof,
    requiresProof: true,
  });
  const posture = custody.recorder.enforcementPosture();
  const enforces = posture === 'enforce';
  // Every condition on this surface is new enforcement, so all of them honour
  // the posture: shadow observes and shares, boundary/strict withhold.
  const withheldReason = reason !== null && enforces ? reason : null;
  if (reason !== null) {
    log.warn('Artifact egress custody condition detected', {
      surface: input.destination.surface,
      audience: input.destination.audience,
      holdReason: reason,
      posture,
      withheld: withheldReason !== null,
    });
  }
  const { written } = await custody.recorder.record({
    surface: 'artifact_share',
    disposition: withheldReason !== null ? 'held' : 'released',
    turnId: custody.turnId,
    attemptRef: `artifact-share:${input.destination.surface}:${input.destination.channelType}:${input.destination.channelId}`,
    contentSha256: artifactPayloadSha256(input.attachments),
    destination,
    proof: custody.proof,
    decisionAllowed: withheldReason === null,
    ...(reason !== null ? { holdReason: reason } : {}),
  });
  if (withheldReason !== null) {
    return { disposition: 'held', attachments: [], holdReason: withheldReason };
  }
  if (!written && enforces) {
    // Custody-store unavailability holds proof-requiring egress; it never
    // degrades to "share anyway" (design §4 rule 6).
    log.error('Artifact egress held: the delivery record could not be written', {
      surface: input.destination.surface,
    });
    return { disposition: 'held', attachments: [], holdReason: 'custody_store_unavailable' };
  }
  return null;
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

  // ccgdz.6: outward artifact egress must be able to prove where its context
  // came from. Evaluated BEFORE the approval queue: an unprovable share is not
  // an operator decision, it is a chain that does not exist.
  if (input.deps.custody) {
    const held = await holdArtifactEgressWithoutCustody({
      attachments,
      destination,
      custody: input.deps.custody,
    });
    if (held) return held;
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

  // Recovery re-authorizes from the artifacts as they exist now; the custody
  // hold is re-evaluated inside `authorizeArtifactEgressInternal` below against
  // THIS run's proof, so a recovered turn never inherits a stale release.
  const currentClassifications = await input.deps.readCurrentClassifications(attachments);
  const classification = requireSingleCurrentClassification(attachments, currentClassifications);
  return authorizeArtifactEgressInternal({
    attachments,
    classification,
    destination,
    deps: input.deps,
  }, true);
}
