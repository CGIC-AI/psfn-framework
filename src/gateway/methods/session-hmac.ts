import { JSONRPCErrorException } from 'json-rpc-2.0';
import {
  GatewayErrors,
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
        throw new JSONRPCErrorException(
          'Gateway session HMAC keyring is not configured',
          GatewayErrors.PROVIDER_ERROR,
        );
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
        throw new JSONRPCErrorException(
          'Gateway session HMAC keyring is not configured',
          GatewayErrors.PROVIDER_ERROR,
        );
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
