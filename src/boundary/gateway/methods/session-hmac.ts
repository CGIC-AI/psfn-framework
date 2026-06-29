import {
  type SessionHmacSignParams,
  type SessionHmacSignResult,
  type SessionHmacVerifyParams,
  type SessionHmacVerifyResult,
} from '../protocol.js';
import { signJournalEntry, verifyJournalEntryIntegrity } from '../../../persistence/journals/journal-utils.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';

// Session integrity RPCs are internal, high-frequency plumbing. Auditing every verify
// self-amplifies transcript reads into gateway audit churn, so these stay off the audit path.
const sessionHmacDescriptors: Array<
  | AuditedMethodDescriptor<SessionHmacSignParams, SessionHmacSignResult>
  | AuditedMethodDescriptor<SessionHmacVerifyParams, SessionHmacVerifyResult>
> = [
  {
    name: 'session.hmac.sign',
    handler: async (params: SessionHmacSignParams, runtime): Promise<SessionHmacSignResult> => {
      return {
        entry: signJournalEntry(params.entry, runtime.sessionHmacKeyring, params.previousHmac),
      };
    },
  },
  {
    name: 'session.hmac.verify',
    handler: async (params: SessionHmacVerifyParams, runtime): Promise<SessionHmacVerifyResult> => {
      return verifyJournalEntryIntegrity(params.entry, runtime.sessionHmacKeyring, params.previousHmac);
    },
  },
];

export function registerSessionHmacMethods(runtime: GatewayMethodRuntime): void {
  for (const descriptor of sessionHmacDescriptors) {
    runtime.target.addMethod(
      descriptor.name,
      (params: unknown) => descriptor.handler(params as never, runtime),
    );
  }
}
