import { apiDelete, apiGet, apiPatch, apiPost, apiPostMultipart } from '$lib/api/client';

export interface GeneratedImageRootView {
  kind: 'personal' | 'companion';
  path: string;
}

export interface GeneratedImageView {
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
}

export interface GeneratedImagesResponse {
  roots: GeneratedImageRootView[];
  images: GeneratedImageView[];
}

export interface ImageReferencePhoto {
  id: string;
  fileName: string;
  contentType: string;
  description: string;
  tags: string[];
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  isDefault: boolean;
}

export interface ImageReferenceListResponse {
  defaultReferenceId?: string;
  references: ImageReferencePhoto[];
}

export interface ImageReferenceMutationResponse {
  ok: boolean;
  reference: ImageReferencePhoto;
}

export function listGeneratedImages(): Promise<GeneratedImagesResponse> {
  return apiGet<GeneratedImagesResponse>('/api/admin/images/generated');
}

export function listImageReferences(): Promise<ImageReferenceListResponse> {
  return apiGet<ImageReferenceListResponse>('/api/admin/image-references');
}

export function uploadImageReference(
  file: File,
  input: {
    description?: string;
    tags?: string[];
    setDefault?: boolean;
  } = {}
): Promise<ImageReferenceMutationResponse> {
  const params = new URLSearchParams();
  if (input.description?.trim()) params.set('description', input.description.trim());
  if (input.tags?.length) params.set('tags', input.tags.join(','));
  if (input.setDefault) params.set('setDefault', 'true');
  const form = new FormData();
  form.append('file', file);
  const query = params.toString();
  return apiPostMultipart<ImageReferenceMutationResponse>(
    `/api/admin/image-references/upload${query ? `?${query}` : ''}`,
    form
  );
}

export function updateImageReference(
  id: string,
  input: {
    description?: string;
    tags?: string[];
    setDefault?: boolean;
  }
): Promise<ImageReferenceMutationResponse> {
  return apiPatch<ImageReferenceMutationResponse>(
    `/api/admin/image-references/${encodeURIComponent(id)}`,
    input
  );
}

export function setDefaultImageReference(id: string): Promise<ImageReferenceMutationResponse> {
  return apiPost<ImageReferenceMutationResponse>(
    `/api/admin/image-references/${encodeURIComponent(id)}/default`
  );
}

export function deleteImageReference(id: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/api/admin/image-references/${encodeURIComponent(id)}`);
}
