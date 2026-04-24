export { createPostgresContactStore } from './postgres-adapter/factory.js';
export type { PostgresContactStoreOptions } from './postgres-adapter/options.js';
export type {
  ContactChannelActivityRow,
  ContactIdentityRow,
  ContactIdentityVerificationRow,
  ContactMutationAuditRow,
  ContactRow,
  SocialGraphEntityRow,
  SocialRelationshipEdgeRow,
} from './postgres-adapter/rows.js';
