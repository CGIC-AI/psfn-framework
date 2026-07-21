import type {
  ImageReferenceBlob,
  ImageReferenceLineageView,
  ImageReferenceListData,
  ImageReferencePhoto,
  ImageReferenceUpdateInput,
  ImageReferenceUploadInput,
} from '../../../../primitives/images/reference-store.js';
import type {
  ArtifactSensitivityClassification,
} from '../../../../shared/contracts/artifact-sensitivity.js';
import type { SensitivityLevel } from '../../../../system/trust/types.js';

export interface AdminGeneratedImageRootView {
  kind: 'personal' | 'companion';
  path: string;
}

export interface AdminGeneratedImageView {
  id: string;
  url: string;
  rootKind: 'personal' | 'companion';
  relativePath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  prompt?: string;
  provider?: string;
  mode?: string;
  model?: string;
  sourceToolName?: string;
  requestId?: string;
  referenceImageIds?: string[];
  favorite: boolean;
  tags: string[];
  meaningfulMoment?: AdminGeneratedImageMeaningfulMoment;
  embodiment?: AdminGeneratedImageEmbodiment;
  autobiography?: AdminGeneratedImageAutobiography;
  conversation?: AdminGeneratedImageConversationLink;
  companionNoteRefs: AdminGeneratedImageCompanionNoteRef[];
  artifactRefs: AdminGeneratedImageArtifactRef[];
  sensitivityClassification?: ArtifactSensitivityClassification;
}

export interface AdminGeneratedImageAutobiographyMilestone {
  marked: boolean;
  markedAt: string;
  label?: string;
}

/**
 * A companion-authored visual autobiography record for an image: the narrative
 * of what this render meant, its emotional context, and an optional milestone
 * marker. `author` is authorship-protected per charter 8.2 — an operator edit
 * cannot silently overwrite companion-authored narrative.
 */
export interface AdminGeneratedImageAutobiography {
  narrative: string;
  emotionalContext?: string;
  milestone?: AdminGeneratedImageAutobiographyMilestone;
  author: 'companion' | 'operator';
  authoredAt: string;
  updatedAt: string;
}

export interface AdminGeneratedImageEmbodiment {
  verdict: 'same_me' | 'drifted' | 'different_person';
  framing?: string;
  note?: string;
  referenceId?: string;
  referenceDescription?: string;
  reviewedAt?: string;
}

export interface AdminGeneratedImageConversationLink {
  channelId?: string;
  channelType?: string;
  turnId?: string;
  requestId?: string;
  sourceMessageId?: string;
  userSessionEntryId?: number;
  assistantSessionEntryId?: number;
}

export interface AdminGeneratedImageCompanionNoteRef {
  id: string;
  label?: string;
  url?: string;
}

export interface AdminGeneratedImageArtifactRef {
  kind: 'generated_image' | 'shared_image' | 'conversation_turn' | 'companion_note' | 'l0_artifact';
  refId?: string;
  label?: string;
  url?: string;
  localPath?: string;
}

export interface AdminGeneratedImageMeaningfulMoment {
  marked: boolean;
  markedAt: string;
  note?: string;
  conversation?: AdminGeneratedImageConversationLink;
}

export interface AdminGeneratedImageListQuery {
  tags?: string[];
  favorite?: boolean;
  meaningful?: boolean;
  milestone?: boolean;
  search?: string;
}

export interface AdminGeneratedImageAutobiographyInput {
  narrative?: string;
  emotionalContext?: string;
  milestone?: {
    marked: boolean;
    label?: string;
  };
  /** Who is authoring this record; defaults to the record's current author or 'operator'. */
  author?: 'companion' | 'operator';
  /** Remove the record entirely. */
  clear?: boolean;
  /** Required to overwrite or clear a companion-authored narrative (charter 8.2). */
  allowOverwriteCompanionAuthored?: boolean;
}

export interface AdminGeneratedImageUpdateInput {
  favorite?: boolean;
  tags?: string[];
  meaningfulMoment?: {
    marked: boolean;
    note?: string;
  };
  autobiography?: AdminGeneratedImageAutobiographyInput;
  conversation?: AdminGeneratedImageConversationLink;
  companionNoteRefs?: AdminGeneratedImageCompanionNoteRef[];
  artifactRefs?: AdminGeneratedImageArtifactRef[];
  sensitivityContest?: {
    sensitivity: SensitivityLevel;
    reason: string;
  };
}

export interface AdminGeneratedImageListData {
  roots: AdminGeneratedImageRootView[];
  images: AdminGeneratedImageView[];
}

export interface AdminImageBlob {
  fileName: string;
  contentType: string;
  data: Buffer;
}

export interface AdminPromoteReferenceInput {
  promotionReason: string;
  description?: string;
  tags?: string[];
  setDefault?: boolean;
}

export interface AdminImagesService {
  listGeneratedImages(query?: AdminGeneratedImageListQuery): Promise<AdminGeneratedImageListData>;
  getGeneratedImageBlob(id: string): Promise<AdminImageBlob | null>;
  updateGeneratedImage(id: string, input: AdminGeneratedImageUpdateInput): Promise<AdminGeneratedImageView>;
  promoteGeneratedImageToReference(id: string, input: AdminPromoteReferenceInput): Promise<ImageReferencePhoto>;
  listReferencePhotos(): Promise<ImageReferenceListData>;
  addReferencePhoto(input: ImageReferenceUploadInput): Promise<ImageReferencePhoto>;
  updateReferencePhoto(id: string, input: ImageReferenceUpdateInput): Promise<ImageReferencePhoto>;
  deleteReferencePhoto(id: string): Promise<void>;
  setDefaultReferencePhoto(id: string): Promise<ImageReferencePhoto>;
  rollbackDefaultReferencePhoto(input?: { reason?: string }): Promise<ImageReferencePhoto>;
  getReferenceLineage(id: string): Promise<ImageReferenceLineageView>;
  getReferencePhotoBlob(id: string): Promise<ImageReferenceBlob | null>;
}
