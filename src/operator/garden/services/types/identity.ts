import type {
  CharacterCardHistoryEntry,
  CharacterCardSnapshot,
} from '../../../../core/identity/card-versioning.js';
import type { CharacterCardV2 } from '../../../../core/identity/types.js';
import type { SubstrateConfig } from '../../../../system/config/runtime-config-contracts.js';
import type { IdentityIntakeReviewState } from '../../identity-intake-types.js';

export interface AdminIdentityData {
  card: CharacterCardV2;
  config: SubstrateConfig;
  version: number;
  checksum?: string;
  history: CharacterCardHistoryEntry[];
  intakeReview: IdentityIntakeReviewState | null;
}

export interface ImportResult {
  ok: boolean;
  message: string;
}

export interface IntakeStageResult {
  ok: boolean;
  message: string;
  review?: IdentityIntakeReviewState | null;
}

export interface IntakeCommitResult {
  ok: boolean;
  message: string;
  review?: IdentityIntakeReviewState | null;
}

export interface RollbackResult {
  ok: boolean;
  message: string;
  snapshot?: CharacterCardSnapshot;
}

export interface DiffPreviewResult {
  ok: boolean;
  current: CharacterCardV2;
  target: CharacterCardV2;
}

export interface FieldUpdateResult {
  ok: boolean;
  message: string;
}

export interface OnboardingActionResult {
  ok: boolean;
  message: string;
  onboardingRequired: boolean;
  action?: 'keep_starter' | 'edit_identity';
  updatedFields?: string[];
}

export interface AdminIdentityService {
  getIdentityData(): AdminIdentityData;
  importIdentityCard(body: string): Promise<ImportResult>;
  stageIdentityIntake(body: string): IntakeStageResult;
  commitIdentityIntake(body: string): Promise<IntakeCommitResult>;
  rollbackIdentityCard(body: string): RollbackResult;
  previewIdentityCardDiff(body: string): DiffPreviewResult;
  updateIdentityField(body: string): FieldUpdateResult;
  applyOnboardingAction(body: string): Promise<OnboardingActionResult>;
}
