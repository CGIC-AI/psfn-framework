// ── Admin GUI HTML Templates ──
// Server-rendered HTML with htmx for interactivity. Garden-themed.

export { layout, loginPage } from './templates/layout.js';
export { dashboardPage } from './templates/dashboard.js';
export { memoryListPage, memoryRow, memoryDetailPage } from './templates/memory.js';
export { sessionListPage, sessionMessagesPage, messageCard } from './templates/sessions.js';
export { schedulerPage, taskRow } from './templates/scheduler.js';
export { shardsPage, shardCard } from './templates/shards.js';
export {
  identityPage,
  identityImportResult,
  identityCardVersionResult,
  identityCardDiffFragment,
} from './templates/identity.js';
export { settingsPage, settingsFormResult } from './templates/settings.js';
export { skillsPage } from './templates/skills.js';
export { primerPage } from './templates/primer.js';
export { confirmationsPage, confirmationQueueFragment } from './templates/confirmations.js';
export { contactsPage, contactRow, contactEditForm } from './templates/contacts.js';
export { chatPage } from './templates/chat.js';
export { eventsPage, eventItem } from './templates/events.js';
export {
  promptsPage,
  promptRegistryFragment,
  promptLayersFragment,
  promptDiffFragment,
  promptDetailPage,
  promptRegistryDetailPage,
} from './templates/prompts.js';
