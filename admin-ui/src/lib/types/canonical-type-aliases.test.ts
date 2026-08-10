import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ChannelPrivacyLevel as CanonicalChannelPrivacyLevel,
  ContactChannelIdentity as CanonicalContactChannelIdentity,
  ContactChannelLink as CanonicalContactChannelLink,
  Contact as CanonicalContact,
  ContactIdentityLinkVerification as CanonicalContactIdentityLinkVerification,
  ContactMutationAuditEntry as CanonicalContactMutationAuditEntry,
  RelationshipType as CanonicalRelationshipType,
  RoomRosterMember as CanonicalRoomRosterMember,
  RoomSummary as CanonicalRoomSummary,
  SocialGraphEntitySource as CanonicalSocialGraphEntitySource,
  SocialRelationshipKind as CanonicalSocialRelationshipKind,
} from '../../../../src/core/contacts/types.js';
import type { WikiRetrievalRequest as CanonicalWikiRetrievalRequest } from '../../../../src/core/agent/contracts.js';
import type {
  SessionRoleEnvelopePreview as CanonicalSessionRoleEnvelopePreview,
} from '../../../../src/core/internal-role-envelopes/projections.js';
import type { CharacterCardHistoryEntry as CanonicalCharacterCardHistoryEntry } from '../../../../src/core/identity/card-versioning.js';
import type { PromptRegistryEntry as CanonicalPromptRegistryEntry } from '../../../../src/core/identity/prompt-registry.js';
import type { CharacterCardV2 as CanonicalCharacterCardV2 } from '../../../../src/core/identity/types.js';
import type { SessionEntry as CanonicalSessionEntry } from '../../../../src/core/session/types.js';
import type {
  ObserverEvalAgreementBand as CanonicalObserverEvalAgreementBand,
  ObserverEvalComparisonSummary as CanonicalObserverEvalComparisonSummary,
  ObserverEvalMetricsStatus as CanonicalObserverEvalMetricsStatus,
} from '../../../../src/core/eval/observer-sidecar/metrics.js';
import type {
  ObserverEvalPsfnEmotionReference as CanonicalObserverEvalPsfnEmotionReference,
  ObserverEvalSidecarErrorState as CanonicalObserverEvalSidecarErrorState,
  ObserverEvalSidecarObservationStatus as CanonicalObserverEvalSidecarObservationStatus,
  ObserverEvalSidecarRetentionMetadata as CanonicalObserverEvalSidecarRetentionMetadata,
  ObserverEvalSidecarRunStatus as CanonicalObserverEvalSidecarRunStatus,
} from '../../../../src/core/eval/observer-sidecar/persistence.js';
import type {
  ObserverEvalPrivacyClass as CanonicalObserverEvalPrivacyClass,
  ObserverEvalPrivacyDecision as CanonicalObserverEvalPrivacyDecision,
  ObserverEvalSanitizedEmotionSnapshot as CanonicalObserverEvalSanitizedEmotionSnapshot,
  ObserverEvalSanitizedProvenance as CanonicalObserverEvalSanitizedProvenance,
  ObserverEvalSanitizedSourceMetadata as CanonicalObserverEvalSanitizedSourceMetadata,
  ObserverEvalSanitizedTurnIdentity as CanonicalObserverEvalSanitizedTurnIdentity,
  ObserverEvalSanitizedTurnMetadata as CanonicalObserverEvalSanitizedTurnMetadata,
} from '../../../../src/core/eval/observer-sidecar/privacy.js';
import type {
  CanonicalModelRegistry as RuntimeCanonicalModelRegistry,
  ModelRegistryBudgetPolicy as RuntimeModelRegistryBudgetPolicy,
  ModelRegistryCapabilityMetadata as RuntimeModelRegistryCapabilityMetadata,
  ModelRegistryCostMetadata as RuntimeModelRegistryCostMetadata,
  ModelRegistryEntry as RuntimeModelRegistryEntry,
  ModelRegistryIdentityMetadata as RuntimeModelRegistryIdentityMetadata,
  ModelRegistryPurposeTag as RuntimeModelRegistryPurposeTag,
  ModelRegistrySourceMetadata as RuntimeModelRegistrySourceMetadata,
  ModelRegistryTuningMetadata as RuntimeModelRegistryTuningMetadata,
} from '../../../../src/shared/contracts/runtime.js';
import type { RecentContactShapeArtifact as CanonicalRecentContactShapeArtifact } from '../../../../src/faculties/memory/memory-store-port.js';
import type { MemoryWithheldSummary as CanonicalMemoryWithheldSummary } from '../../../../src/faculties/memory/withheld-summary.js';
import type {
  ContactConversationChannelView as CanonicalContactConversationChannelView,
} from '../../../../src/operator/garden/services/contact-session-linker.js';
import type { SchedulerMutationResult as CanonicalSchedulerMutationResult } from '../../../../src/operator/garden/services/scheduler-service.js';
import type {
  SubsystemHealthSnapshot as CanonicalSubsystemHealthSnapshot,
  SubsystemLaneEvent as CanonicalSubsystemLaneEvent,
  SubsystemLaneHealth as CanonicalSubsystemLaneHealth,
  SubsystemLaneOutcome as CanonicalSubsystemLaneOutcome,
  SubsystemLaneSource as CanonicalSubsystemLaneSource,
  SubsystemLaneStatus as CanonicalSubsystemLaneStatus,
} from '../../../../src/operator/garden/services/subsystem-health-service.js';
import type {
  AdminSessionRoleEnvelopePreview as CanonicalAdminSessionRoleEnvelopePreview,
} from '../../../../src/operator/garden/services/types/continuity.js';
import type { ContactUpdateResult as CanonicalContactUpdateResult } from '../../../../src/operator/garden/services/types/contacts.js';
import type {
  AdminTurnMemorySnapshotData as CanonicalAdminTurnMemorySnapshotData,
  AdminTurnSessionContextSnapshotData as CanonicalAdminTurnSessionContextSnapshotData,
  AdminTurnSnapshotData as CanonicalAdminTurnSnapshotData,
} from '../../../../src/operator/garden/services/types/prompt-loom.js';
import type { RuntimePromptUpdateResult as CanonicalRuntimePromptUpdateResult } from '../../../../src/operator/garden/services/types/prompts.js';
import type {
  AdminSessionMessageOntologyView as CanonicalAdminSessionMessageOntologyView,
} from '../../../../src/operator/garden/services/types/sessions.js';
import type {
  ChannelInfo as CanonicalChannelInfo,
  CompactionAuditView as CanonicalCompactionAuditView,
} from '../../../../src/operator/garden/types.js';
import type { DiscoveredModel as CanonicalDiscoveredModel } from '../../../../src/primitives/llm/discovery.js';
import type { ImageReferencePhoto as CanonicalImageReferencePhoto } from '../../../../src/primitives/images/reference-store.js';
import type { IntakeQuarantineDecisionAction as CanonicalIntakeQuarantineDecisionAction } from '../../../../src/core/cogsec/intake/quarantine-store.js';
import type {
  ChannelEnvelopeLabel as CanonicalChannelEnvelopeLabel,
  ChannelPrivacy as CanonicalChannelPrivacy,
  ContactTrackingMode as CanonicalContactTrackingMode,
} from '../../../../src/system/trust/context-envelope.js';
import type { ChannelClassificationSource as CanonicalChannelClassificationSource } from '../../../../src/system/trust/policy.js';
import type { TrustLevel as CanonicalTrustLevel } from '../../../../src/system/trust/types.js';
import type {
  ChannelClassificationSource,
  ChannelEnvelopeLabel,
  ChannelPrivacy,
  ContactTrackingMode,
} from '../api/endpoints/channels.js';
import type { ContactUpdatePayload } from '../api/endpoints/contacts.js';
import type { ImageReferencePhoto } from '../api/endpoints/images.js';
import type { IntakeQuarantineDecisionAction } from '../api/endpoints/intake.js';
import type { RoomRosterMember, RoomSummary } from '../api/endpoints/rooms.js';
import type { WikiRetrievalRequest } from '../../../../src/faculties/wiki/retrieval.js';
import type {
  CanonicalModelRegistry,
  ModelRegistryBudgetPolicy,
  ModelRegistryCapabilityMetadata,
  ModelRegistryCostMetadata,
  ModelRegistryEntry,
  ModelRegistryIdentityMetadata,
  ModelRegistryPurposeTag,
  ModelRegistrySourceMetadata,
  ModelRegistryTuningMetadata,
} from '../models/registry.js';
import type {
  ObserverEvalAgreementBand,
  ObserverEvalComparisonSummary,
  ObserverEvalMetricsStatus,
  ObserverEvalPrivacyClass,
  ObserverEvalPrivacyDecision,
  ObserverEvalPsfnEmotionReference,
  ObserverEvalSanitizedEmotionSnapshot,
  ObserverEvalSanitizedProvenance,
  ObserverEvalSanitizedSourceMetadata,
  ObserverEvalSanitizedTurnIdentity,
  ObserverEvalSanitizedTurnMetadata,
  ObserverEvalSidecarErrorState,
  ObserverEvalSidecarObservationStatus,
  ObserverEvalSidecarRetentionMetadata,
  ObserverEvalSidecarRunStatus,
} from '../api/endpoints/observer-eval-sidecar.js';
import type {
  AdminSessionMessageOntologyView,
  AdminSessionRoleEnvelopePreview,
  AdminTurnMemorySnapshotData,
  AdminTurnSessionContextSnapshotData,
  AdminTurnSnapshotData,
  ChannelInfo,
  ChannelPrivacyLevel,
  CharacterCardHistoryEntry,
  CharacterCardV2,
  CompactionAuditView,
  Contact,
  ContactChannelIdentity,
  ContactChannelLink,
  ContactConversationChannelView,
  ContactIdentityLinkVerification,
  ContactMutationAuditEntry,
  RecentContactShapeArtifact,
  ContactUpdateResult,
  DiscoveredModel,
  MemoryWithheldSummary,
  PromptRegistryEntry,
  RelationshipType,
  RuntimePromptUpdateResult,
  SchedulerMutationResult,
  SessionEntry,
  SessionRoleEnvelopePreview,
  SocialGraphEntitySource,
  SocialRelationshipKind,
  SubsystemHealthSnapshot,
  SubsystemLaneEvent,
  SubsystemLaneHealth,
  SubsystemLaneOutcome,
  SubsystemLaneSource,
  SubsystemLaneStatus,
  TrustLevel,
} from './index.js';

describe('admin canonical type aliases', () => {
  it('keeps contact and trust types identical to their backend contracts', () => {
    expectTypeOf<Contact>().toEqualTypeOf<CanonicalContact>();
    expectTypeOf<ChannelPrivacyLevel>().toEqualTypeOf<CanonicalChannelPrivacyLevel>();
    expectTypeOf<RelationshipType>().toEqualTypeOf<CanonicalRelationshipType>();
    expectTypeOf<SocialGraphEntitySource>().toEqualTypeOf<CanonicalSocialGraphEntitySource>();
    expectTypeOf<SocialRelationshipKind>().toEqualTypeOf<CanonicalSocialRelationshipKind>();
    expectTypeOf<TrustLevel>().toEqualTypeOf<CanonicalTrustLevel>();

    expect(true).toBe(true);
  });

  it('keeps session and prompt-loom views identical to their Garden contracts', () => {
    expectTypeOf<SessionEntry>().toEqualTypeOf<CanonicalSessionEntry>();
    expectTypeOf<ChannelInfo>().toEqualTypeOf<CanonicalChannelInfo>();
    expectTypeOf<CompactionAuditView>().toEqualTypeOf<CanonicalCompactionAuditView>();
    expectTypeOf<MemoryWithheldSummary>().toEqualTypeOf<CanonicalMemoryWithheldSummary>();
    expectTypeOf<SessionRoleEnvelopePreview>()
      .toEqualTypeOf<CanonicalSessionRoleEnvelopePreview>();
    expectTypeOf<AdminSessionRoleEnvelopePreview>()
      .toEqualTypeOf<CanonicalAdminSessionRoleEnvelopePreview>();
    expectTypeOf<AdminSessionMessageOntologyView>()
      .toEqualTypeOf<CanonicalAdminSessionMessageOntologyView>();
    expectTypeOf<AdminTurnSessionContextSnapshotData>()
      .toEqualTypeOf<CanonicalAdminTurnSessionContextSnapshotData>();
    expectTypeOf<AdminTurnMemorySnapshotData>()
      .toEqualTypeOf<CanonicalAdminTurnMemorySnapshotData>();
    // Canonical snapshots fit the admin view; the inverse intentionally does not
    // because the admin view tolerates historical pre-plan persisted fields.
    expectTypeOf<CanonicalAdminTurnSnapshotData>().toMatchTypeOf<AdminTurnSnapshotData>();

    expect(true).toBe(true);
  });

  it('keeps contact Garden views identical to their backend contracts', () => {
    expectTypeOf<ContactChannelIdentity>().toEqualTypeOf<CanonicalContactChannelIdentity>();
    expectTypeOf<ContactChannelLink>().toEqualTypeOf<CanonicalContactChannelLink>();
    expectTypeOf<RecentContactShapeArtifact>().toEqualTypeOf<CanonicalRecentContactShapeArtifact>();
    expectTypeOf<ContactConversationChannelView>()
      .toEqualTypeOf<CanonicalContactConversationChannelView>();
    expectTypeOf<ContactUpdateResult>().toEqualTypeOf<CanonicalContactUpdateResult>();
    expectTypeOf<ContactIdentityLinkVerification>()
      .toEqualTypeOf<CanonicalContactIdentityLinkVerification>();
    expectTypeOf<ContactMutationAuditEntry>()
      .toEqualTypeOf<CanonicalContactMutationAuditEntry>();

    expect(true).toBe(true);
  });

  it('keeps identity, prompt, model, and scheduler types canonical', () => {
    expectTypeOf<CharacterCardV2>().toEqualTypeOf<CanonicalCharacterCardV2>();
    expectTypeOf<CharacterCardHistoryEntry>()
      .toEqualTypeOf<CanonicalCharacterCardHistoryEntry>();
    expectTypeOf<PromptRegistryEntry>().toEqualTypeOf<CanonicalPromptRegistryEntry>();
    expectTypeOf<RuntimePromptUpdateResult>()
      .toEqualTypeOf<CanonicalRuntimePromptUpdateResult>();
    expectTypeOf<DiscoveredModel>().toEqualTypeOf<CanonicalDiscoveredModel>();
    expectTypeOf<SchedulerMutationResult>().toEqualTypeOf<CanonicalSchedulerMutationResult>();

    expect(true).toBe(true);
  });

  it('keeps subsystem health types identical to the service contract', () => {
    expectTypeOf<SubsystemLaneOutcome>().toEqualTypeOf<CanonicalSubsystemLaneOutcome>();
    expectTypeOf<SubsystemLaneStatus>().toEqualTypeOf<CanonicalSubsystemLaneStatus>();
    expectTypeOf<SubsystemLaneSource>().toEqualTypeOf<CanonicalSubsystemLaneSource>();
    expectTypeOf<SubsystemLaneEvent>().toEqualTypeOf<CanonicalSubsystemLaneEvent>();
    expectTypeOf<SubsystemLaneHealth>().toEqualTypeOf<CanonicalSubsystemLaneHealth>();
    expectTypeOf<SubsystemHealthSnapshot>().toEqualTypeOf<CanonicalSubsystemHealthSnapshot>();

    expect(true).toBe(true);
  });

  it('keeps endpoint payload types identical to their serving contracts', () => {
    expectTypeOf<RoomSummary>().toEqualTypeOf<CanonicalRoomSummary>();
    expectTypeOf<RoomRosterMember>().toEqualTypeOf<CanonicalRoomRosterMember>();
    expectTypeOf<IntakeQuarantineDecisionAction>()
      .toEqualTypeOf<CanonicalIntakeQuarantineDecisionAction>();
    expectTypeOf<ImageReferencePhoto>().toEqualTypeOf<CanonicalImageReferencePhoto>();
    expectTypeOf<ChannelPrivacy>().toEqualTypeOf<CanonicalChannelPrivacy>();
    expectTypeOf<ContactTrackingMode>().toEqualTypeOf<CanonicalContactTrackingMode>();
    expectTypeOf<ChannelClassificationSource>()
      .toEqualTypeOf<CanonicalChannelClassificationSource>();
    expectTypeOf<ChannelEnvelopeLabel>().toEqualTypeOf<CanonicalChannelEnvelopeLabel>();
    expectTypeOf<ContactUpdatePayload['trustLevel']>()
      .toEqualTypeOf<CanonicalTrustLevel | undefined>();
    expectTypeOf<ContactUpdatePayload['relationshipType']>()
      .toEqualTypeOf<CanonicalRelationshipType | undefined>();
    expectTypeOf<WikiRetrievalRequest>().toEqualTypeOf<CanonicalWikiRetrievalRequest>();

    expect(true).toBe(true);
  });

  it('keeps the model registry cluster identical to its backend contracts', () => {
    expectTypeOf<CanonicalModelRegistry>().toEqualTypeOf<RuntimeCanonicalModelRegistry>();
    expectTypeOf<ModelRegistryBudgetPolicy>().toEqualTypeOf<RuntimeModelRegistryBudgetPolicy>();
    expectTypeOf<ModelRegistryCapabilityMetadata>().toEqualTypeOf<RuntimeModelRegistryCapabilityMetadata>();
    expectTypeOf<ModelRegistryCostMetadata>().toEqualTypeOf<RuntimeModelRegistryCostMetadata>();
    expectTypeOf<ModelRegistryEntry>().toEqualTypeOf<RuntimeModelRegistryEntry>();
    expectTypeOf<ModelRegistryIdentityMetadata>().toEqualTypeOf<RuntimeModelRegistryIdentityMetadata>();
    expectTypeOf<ModelRegistryPurposeTag>().toEqualTypeOf<RuntimeModelRegistryPurposeTag>();
    expectTypeOf<ModelRegistrySourceMetadata>().toEqualTypeOf<RuntimeModelRegistrySourceMetadata>();
    expectTypeOf<ModelRegistryTuningMetadata>().toEqualTypeOf<RuntimeModelRegistryTuningMetadata>();

    expect(true).toBe(true);
  });

  it('keeps observer-eval sidecar payload types identical to their backend contracts', () => {
    expectTypeOf<ObserverEvalSidecarObservationStatus>()
      .toEqualTypeOf<CanonicalObserverEvalSidecarObservationStatus>();
    expectTypeOf<ObserverEvalSidecarRunStatus>()
      .toEqualTypeOf<CanonicalObserverEvalSidecarRunStatus>();
    expectTypeOf<ObserverEvalPrivacyClass>().toEqualTypeOf<CanonicalObserverEvalPrivacyClass>();
    expectTypeOf<ObserverEvalAgreementBand>().toEqualTypeOf<CanonicalObserverEvalAgreementBand>();
    expectTypeOf<ObserverEvalMetricsStatus>().toEqualTypeOf<CanonicalObserverEvalMetricsStatus>();
    expectTypeOf<ObserverEvalPrivacyDecision>()
      .toEqualTypeOf<CanonicalObserverEvalPrivacyDecision>();
    expectTypeOf<ObserverEvalPsfnEmotionReference>()
      .toEqualTypeOf<CanonicalObserverEvalPsfnEmotionReference>();
    expectTypeOf<ObserverEvalSidecarErrorState>()
      .toEqualTypeOf<CanonicalObserverEvalSidecarErrorState>();
    expectTypeOf<ObserverEvalSidecarRetentionMetadata>()
      .toEqualTypeOf<CanonicalObserverEvalSidecarRetentionMetadata>();
    expectTypeOf<ObserverEvalComparisonSummary>()
      .toEqualTypeOf<CanonicalObserverEvalComparisonSummary>();

    expect(true).toBe(true);
  });

  it('keeps observer-eval sanitized payload types identical to their backend contracts', () => {
    expectTypeOf<ObserverEvalSanitizedTurnIdentity>()
      .toEqualTypeOf<CanonicalObserverEvalSanitizedTurnIdentity>();
    expectTypeOf<ObserverEvalSanitizedSourceMetadata>()
      .toEqualTypeOf<CanonicalObserverEvalSanitizedSourceMetadata>();
    expectTypeOf<ObserverEvalSanitizedEmotionSnapshot>()
      .toEqualTypeOf<CanonicalObserverEvalSanitizedEmotionSnapshot>();
    expectTypeOf<ObserverEvalSanitizedTurnMetadata>()
      .toEqualTypeOf<CanonicalObserverEvalSanitizedTurnMetadata>();
    expectTypeOf<ObserverEvalSanitizedProvenance>()
      .toEqualTypeOf<CanonicalObserverEvalSanitizedProvenance>();

    expect(true).toBe(true);
  });

  it('rejects retired privacy and non-canonical model registry fields', () => {
    // @ts-expect-error broadcast is an envelope flag, not a channel privacy level.
    const retiredPrivacy: ChannelPrivacyLevel = 'broadcast';
    const canonicalEntry: ModelRegistryEntry = {
      id: 'primary',
      rank: 10,
      identity: {
        provider: 'openrouter',
        model: 'example/model',
        source: { type: 'openrouter' },
      },
      purposes: [{ purpose: 'chat', primary: true }],
      // routing is now a canonical ModelRegistryEntry field via
      // ModelRegistryRoutingMetadata (provider-driven routing), so it is accepted.
      routing: { providerOrder: ['openrouter'] },
    };

    expect(retiredPrivacy).toBe('broadcast');
    expect(canonicalEntry).toHaveProperty('routing');
  });
});
