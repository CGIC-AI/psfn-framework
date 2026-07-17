import type { SessionManager } from '../../../core/session/manager.js';

export type ExtractionSessionReader = Pick<
  SessionManager,
  'characterName' | 'getRecentMessages' | 'intakeSinkGate'
>;

export type MemoryExtractionSessionPort = ExtractionSessionReader & Pick<
  SessionManager,
  | 'getMessageCount'
  | 'resolveSessionChannelId'
  | 'isSessionRetiredOrQuarantined'
>;
