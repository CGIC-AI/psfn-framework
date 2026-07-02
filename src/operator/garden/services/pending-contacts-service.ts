// ── Garden pending contact approvals service (E3.4) ──
// Operator-facing surface over the durable pending-contact approval queue
// populated by the contact-tracking policy gate for channels configured with
// contactTracking: 'approval' (channels.json contextEnvelope).
//
// Decision semantics:
//   approve — creates the contact through the NORMAL channel-identity upsert
//             path (contactStore.resolveChannelIdentity) and removes the queue
//             entry; subsequent messages from the speaker resolve normally.
//   deny    — the entry persists with status 'denied'; the speaker stays
//             untracked and is never re-enqueued.
//   reset   — removes the entry entirely; the speaker's next message
//             re-proposes (this is the only re-proposal path besides an
//             explicit operator re-request).

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type {
  PendingContactApprovalEntry,
  PendingContactApprovalStore,
} from '../../../core/contacts/pending-contact-approvals.js';

export interface AdminPendingContactApprovalView {
  id: string;
  channel: string;
  channelUserId: string;
  displayName: string;
  channelId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  messagePreviews: Array<{ messageId: string; preview: string; at: string }>;
  status: 'pending' | 'denied';
  decidedAt?: string;
}

export interface AdminPendingContactListData {
  entries: AdminPendingContactApprovalView[];
}

export type AdminPendingContactMutationResult =
  | { ok: true; contactId?: string }
  | { ok: false; message: string };

export interface AdminPendingContactsService {
  listPendingContactApprovals(): Promise<AdminPendingContactListData>;
  approvePendingContact(id: string): Promise<AdminPendingContactMutationResult>;
  denyPendingContact(id: string): Promise<AdminPendingContactMutationResult>;
  resetPendingContactDecision(id: string): Promise<AdminPendingContactMutationResult>;
}

function toView(entry: PendingContactApprovalEntry): AdminPendingContactApprovalView {
  return {
    id: entry.id,
    channel: entry.channel,
    channelUserId: entry.channelUserId,
    displayName: entry.displayName,
    channelId: entry.channelId,
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
    messagePreviews: entry.messagePreviews.map(preview => ({ ...preview })),
    status: entry.status,
    ...(entry.decidedAt ? { decidedAt: entry.decidedAt } : {}),
  };
}

export function createAdminPendingContactsService(options: {
  pendingApprovals: PendingContactApprovalStore;
  contactStore: ContactStorePort | null;
}): AdminPendingContactsService {
  const { pendingApprovals, contactStore } = options;

  return {
    async listPendingContactApprovals(): Promise<AdminPendingContactListData> {
      const entries = await pendingApprovals.list();
      return { entries: entries.map(toView) };
    },

    async approvePendingContact(id: string): Promise<AdminPendingContactMutationResult> {
      const entry = await pendingApprovals.getById(id);
      if (!entry) {
        return { ok: false, message: 'Pending contact approval not found' };
      }
      if (!contactStore) {
        return { ok: false, message: 'Contact store is not available' };
      }
      // Normal upsert path: identical to what an 'auto' channel would have
      // done at ingress, so post-approval messages resolve normally.
      const contact = await contactStore.resolveChannelIdentity(
        entry.channel,
        entry.channelUserId,
        entry.displayName,
      );
      await pendingApprovals.remove(id);
      return { ok: true, contactId: contact.id };
    },

    async denyPendingContact(id: string): Promise<AdminPendingContactMutationResult> {
      const denied = await pendingApprovals.markDenied(id);
      if (!denied) {
        return { ok: false, message: 'Pending contact approval not found' };
      }
      return { ok: true };
    },

    async resetPendingContactDecision(id: string): Promise<AdminPendingContactMutationResult> {
      const removed = await pendingApprovals.remove(id);
      if (!removed) {
        return { ok: false, message: 'Pending contact approval not found' };
      }
      return { ok: true };
    },
  };
}
