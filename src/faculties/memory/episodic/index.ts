export {
  EpisodicStore,
  type EpisodeArcListOptions,
  type EpisodeArcWriteInput,
  type EpisodeClaimTransferInput,
  type EpisodeClaimTransferResult,
  type EpisodeCreateInput,
  type EpisodeLifecycleStatus,
  type EpisodeListOptions,
  type EpisodeMessageClaim,
  type EpisodeMessageClaimEntryInput,
  type EpisodeMessageClaimListOptions,
  type EpisodeMessageClaimStatus,
  type EpisodeMessageClaimWriteInput,
  type EpisodeTimeSearchOptions,
  type EpisodeUpdateInput,
  type EpisodicStoreOptions,
  type EpisodicStorePort,
  type EpisodicStoreResult,
} from './store.js';
export {
  PostgresEpisodicStore,
  createPostgresEpisodicStore,
  createPostgresEpisodicStoreFromPool,
} from './postgres-store.js';
export {
  DreamMeaningPass,
  parseMeaningContribution,
  type DreamMeaningPassOptions,
  type DreamMeaningPassRunInput,
  type DreamMeaningPassRunResult,
  type DreamPassAgent,
} from './dream-meaning-pass.js';
export {
  EpisodeArcWeaver,
  parseProposedArcs,
  type ArcFormationOptions,
  type ArcFormationRunInput,
  type ArcFormationRunResult,
} from './arc-formation.js';
export {
  SleepCycleEpisodeConsolidator,
  buildConsolidatedEpisodeInput,
  buildMergeChains,
  parseThematicGrouping,
  type SleepConsolidationFailureEvent,
  type SleepConsolidationSessionReader,
  type SleepCycleConsolidationOptions,
  type SleepCycleConsolidationResult,
  type SleepCycleConsolidationRunInput,
} from './sleep-consolidation.js';
export {
  EpisodicSynthesizer,
  sessionEntryClaimKey,
  type EpisodicSynthesisOptions,
  type EpisodicSynthesisProcessingWatermark,
  type EpisodicSynthesisRunInput,
  type EpisodicSynthesisRunResult,
  type EpisodicSynthesisWatermarkScope,
  type EpisodicSynthesisSessionReader,
} from './synthesis.js';
export type {
  Episode,
  EpisodeAffect,
  EpisodeArc,
  EpisodeArcKind,
  EpisodeArtifactRef,
  EpisodeProvenanceRef,
  EpisodeSalience,
  EpisodeSpanRef,
} from '../../../shared/contracts/episodic-memory.js';
export {
  EPISODE_ARC_KINDS,
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  parseEpisodeArc,
  serializeEpisode,
  serializeEpisodeArc,
} from '../../../shared/contracts/episodic-memory.js';
