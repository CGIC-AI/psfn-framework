import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminContactsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  contactsPage(): string {
    return this.legacy.contactsPage();
  }

  contactMutationAuditFragment(params?: URLSearchParams): string {
    return this.legacy.contactMutationAuditFragment(params);
  }

  contactsListFragment(): string {
    return this.legacy.contactsListFragment();
  }

  contactEditFormFragment(contactId: string): string {
    return this.legacy.contactEditFormFragment(contactId);
  }

  handleContactUpdate(contactId: string, body: string): string {
    return this.legacy.handleContactUpdate(contactId, body);
  }
}
