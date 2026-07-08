import type {
  ImageReferenceBlob,
  ImageReferenceListData,
  ImageReferencePhoto,
  ImageReferenceUpdateInput,
  ImageReferenceUploadInput,
} from '../../../../primitives/images/reference-store.js';

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
  conversation?: AdminGeneratedImageConversationLink;
  companionNoteRefs: AdminGeneratedImageCompanionNoteRef[];
  artifactRefs: AdminGeneratedImageArtifactRef[];
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
  search?: string;
}

export interface AdminGeneratedImageUpdateInput {
  favorite?: boolean;
  tags?: string[];
  meaningfulMoment?: {
    marked: boolean;
    note?: string;
  };
  conversation?: AdminGeneratedImageConversationLink;
  companionNoteRefs?: AdminGeneratedImageCompanionNoteRef[];
  artifactRefs?: AdminGeneratedImageArtifactRef[];
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

export interface AdminImagesService {
  listGeneratedImages(query?: AdminGeneratedImageListQuery): Promise<AdminGeneratedImageListData>;
  getGeneratedImageBlob(id: string): Promise<AdminImageBlob | null>;
  updateGeneratedImage(id: string, input: AdminGeneratedImageUpdateInput): Promise<AdminGeneratedImageView>;
  listReferencePhotos(): Promise<ImageReferenceListData>;
  addReferencePhoto(input: ImageReferenceUploadInput): Promise<ImageReferencePhoto>;
  updateReferencePhoto(id: string, input: ImageReferenceUpdateInput): Promise<ImageReferencePhoto>;
  deleteReferencePhoto(id: string): Promise<void>;
  setDefaultReferencePhoto(id: string): Promise<ImageReferencePhoto>;
  getReferencePhotoBlob(id: string): Promise<ImageReferenceBlob | null>;
}
