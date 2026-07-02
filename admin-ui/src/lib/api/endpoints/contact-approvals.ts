import { apiGet, apiPost } from '$lib/api/client';

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

/**
 * Fetch pending contact approvals (contact-tracking policy gate, E3.4).
 * Endpoint: GET /api/admin/contact-approvals
 */
export function getContactApprovals(): Promise<ContactApprovalListData> {
  return apiGet<ContactApprovalListData>('/api/admin/contact-approvals');
}

/**
 * Approve a pending contact: creates the contact through the normal upsert
 * path so subsequent messages from the speaker resolve normally.
 * Endpoint: POST /api/admin/contact-approvals/:id/approve
 */
export function approveContactApproval(id: string): Promise<ContactApprovalMutationResult> {
  return apiPost<ContactApprovalMutationResult>(`/api/admin/contact-approvals/${encodeURIComponent(id)}/approve`, {});
}

/**
 * Deny a pending contact: the decision persists and the speaker stays
 * untracked without re-enqueueing on every message.
 * Endpoint: POST /api/admin/contact-approvals/:id/deny
 */
export function denyContactApproval(id: string): Promise<ContactApprovalMutationResult> {
  return apiPost<ContactApprovalMutationResult>(`/api/admin/contact-approvals/${encodeURIComponent(id)}/deny`, {});
}

/**
 * Reset a recorded decision (removes the entry); the speaker's next message
 * re-proposes the contact.
 * Endpoint: POST /api/admin/contact-approvals/:id/reset
 */
export function resetContactApproval(id: string): Promise<ContactApprovalMutationResult> {
  return apiPost<ContactApprovalMutationResult>(`/api/admin/contact-approvals/${encodeURIComponent(id)}/reset`, {});
}
