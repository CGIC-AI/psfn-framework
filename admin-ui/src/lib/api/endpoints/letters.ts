import { apiGet, apiPost } from '$lib/api/client';
import type { LetterRecord } from '../../../../../src/core/letters/contracts.js';

export interface LettersListResponse {
  letters: LetterRecord[];
  waitingCount: number;
  boundary: string;
}

export function listLetters(): Promise<LettersListResponse> {
  return apiGet<LettersListResponse>('/api/admin/letters');
}

export function composeLetter(input: { subject: string; body: string; draft?: boolean }): Promise<{ letter: LetterRecord }> {
  return apiPost<{ letter: LetterRecord }>('/api/admin/letters', input);
}

export function placeLetter(id: string): Promise<{ letter: LetterRecord }> {
  return apiPost<{ letter: LetterRecord }>(`/api/admin/letters/${encodeURIComponent(id)}/place`);
}

export function readLetter(id: string): Promise<{ letter: LetterRecord }> {
  return apiPost<{ letter: LetterRecord }>(`/api/admin/letters/${encodeURIComponent(id)}/read`);
}

export function archiveLetter(id: string): Promise<{ letter: LetterRecord }> {
  return apiPost<{ letter: LetterRecord }>(`/api/admin/letters/${encodeURIComponent(id)}/archive`);
}

export type { LetterRecord };
