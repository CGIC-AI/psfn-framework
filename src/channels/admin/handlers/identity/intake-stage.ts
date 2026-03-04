import type { CharacterCardV2 } from '../../../../identity/types.js';
import type {
  IdentityIntakeChatChunk,
  IdentityIntakeCardMutation,
  IdentityIntakeFlash,
  IdentityIntakeItemStatus,
  IdentityIntakeMemoryItem,
  IdentityIntakeSourceSummary,
} from '../../templates/identity.js';
import type { StagedIntakeChatMessage } from './intake-parsing.js';

export const INTAKE_CARD_DIFF_FIELDS: Array<{ key: keyof CharacterCardV2['data']; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'personality', label: 'Personality' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'first_mes', label: 'First Message' },
  { key: 'mes_example', label: 'Message Example' },
  { key: 'system_prompt', label: 'System Prompt' },
  { key: 'post_history_instructions', label: 'Post-History Instructions' },
  { key: 'tags', label: 'Tags' },
  { key: 'creator', label: 'Creator' },
  { key: 'creator_notes', label: 'Creator Notes' },
];

export type IntakeStageStatus = 'pending' | 'partially_committed' | 'committed' | 'rejected';

export interface StagedIntakeSource {
  kind: IdentityIntakeSourceSummary['kind'];
  path: string;
  itemCount: number;
  note?: string;
}

export interface StagedIntakeCardMutation {
  sourcePath: string;
  containerFormat: string;
  spec: string;
  warnings: string[];
  status: IdentityIntakeItemStatus;
  rows: IdentityIntakeCardMutation['rows'];
  importedCard: CharacterCardV2;
}

export interface StagedIntakeChatMutation {
  channelId: string;
  chunkTargetTokens: number;
  messages: StagedIntakeChatMessage[];
  chunks: IdentityIntakeChatChunk[];
}

export interface StagedIntakeMemoryMutation extends Omit<IdentityIntakeMemoryItem, 'textPreview'> {
  text: string;
}

export interface StagedIdentityIntake {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: IntakeStageStatus;
  sources: StagedIntakeSource[];
  cardMutation: StagedIntakeCardMutation | null;
  chatMutation: StagedIntakeChatMutation | null;
  memoryMutations: StagedIntakeMemoryMutation[];
}

export interface IntakeFlash {
  kind: IdentityIntakeFlash['kind'];
  message: string;
}
