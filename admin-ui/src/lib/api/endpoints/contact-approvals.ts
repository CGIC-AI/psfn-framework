import { apiPost } from '$lib/api/client';
import {
  createQueuePageCache,
  isContactApprovalListData,
} from '$lib/cache/queue-cache';
import type { LocalFirstDataSource, LocalFirstResult } from '$lib/cache/local-first';

export interface ContactApprovalMessagePreview {
  messageId: string;
  preview: string;
  at: string;
}

export interface ContactApprovalEntry {
  id: string;
  channel: string;
  channelUserId: string;
  displayName: string;
  channelId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  messagePreviews: ContactApprovalMessagePreview[];
  status: 'pending' | 'denied';
  decidedAt?: string;
}

export interface ContactApprovalListData {
  entries: ContactApprovalEntry[];
}

export interface ContactApprovalMutationResult {
  ok: boolean;
  contactId?: string;
  message?: string;
}

const contactApprovalCache = createQueuePageCache({
  key: 'contact-approvals',
  path: '/api/admin/contact-approvals',
  validate: isContactApprovalListData,
});

export function loadContactApprovalsLocalFirst(
  onData: (data: ContactApprovalListData, source: LocalFirstDataSource) => void,
): Promise<LocalFirstResult<ContactApprovalListData>> {
  return contactApprovalCache.load(onData);
}

/**
 * Approve a pending contact: creates the contact through the normal upsert
 * path so subsequent messages from the speaker resolve normally.
 * Endpoint: POST /api/admin/contact-approvals/:id/approve
 */
export function approveContactApproval(id: string): Promise<ContactApprovalMutationResult> {
  return apiPost<ContactApprovalMutationResult>(
    `/api/admin/contact-approvals/${encodeURIComponent(id)}/approve`,
  );
}

/**
 * Deny a pending contact: the decision persists and the speaker stays
 * untracked without re-enqueueing on every message.
 * Endpoint: POST /api/admin/contact-approvals/:id/deny
 */
export function denyContactApproval(id: string): Promise<ContactApprovalMutationResult> {
  return apiPost<ContactApprovalMutationResult>(
    `/api/admin/contact-approvals/${encodeURIComponent(id)}/deny`,
  );
}

/**
 * Reset a recorded decision (removes the entry); the speaker's next message
 * re-proposes the contact.
 * Endpoint: POST /api/admin/contact-approvals/:id/reset
 */
export function resetContactApproval(id: string): Promise<ContactApprovalMutationResult> {
  return apiPost<ContactApprovalMutationResult>(
    `/api/admin/contact-approvals/${encodeURIComponent(id)}/reset`,
  );
}
