import {
  type SessionHmacSignParams,
  type SessionHmacSignResult,
  type SessionHmacVerifyParams,
  type SessionHmacVerifyResult,
} from '../protocol.js';
import { signJournalEntry, verifyJournalEntryIntegrity } from '../../session/journal-utils.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

const sessionHmacDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'session.hmac.sign',
    handler: async (params: SessionHmacSignParams, runtime): Promise<SessionHmacSignResult> => {
      if (!runtime.sessionHmacKeyring) {
        return { entry: params.entry };
      }
      return {
        entry: signJournalEntry(params.entry, runtime.sessionHmacKeyring, params.previousHmac),
      };
    },
    summary: (p: SessionHmacSignParams) => ({
      type: p.entry.type,
      channelId: p.entry.channelId,
      id: p.entry.id,
    }),
  },
  {
    name: 'session.hmac.verify',
    handler: async (params: SessionHmacVerifyParams, runtime): Promise<SessionHmacVerifyResult> => {
      if (!runtime.sessionHmacKeyring) {
        // No keyring configured means integrity checking is disabled — not a tamper signal.
        // Return verified: true so entries load normally without <unverified_history> wrapping.
        return {
          verified: true,
          observedHmac: typeof params.entry._hmac === 'string' ? params.entry._hmac : null,
          reason: 'integrity_disabled',
        };
      }
      return verifyJournalEntryIntegrity(params.entry, runtime.sessionHmacKeyring, params.previousHmac);
    },
    summary: (p: SessionHmacVerifyParams) => ({
      type: p.entry.type,
      channelId: p.entry.channelId,
      id: p.entry.id,
      keyVersion: p.entry._hmacKeyVersion,
    }),
  },
];

export function registerSessionHmacMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, sessionHmacDescriptors);
}
