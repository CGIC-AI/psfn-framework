import {
  parseContactAuthorityLifecycleRequest,
  parseContactAuthorityLifecycleResult,
} from '../../../shared/contracts/contact-authority-lifecycle.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import type {
  ContactLifecycleExecuteParams,
  ContactLifecycleExecuteResult,
} from '../protocol.js';
import { registerAuditedDescriptors } from './register.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';

function parseParams(input: unknown): ContactLifecycleExecuteParams {
  if (!isRecord(input)) throw new Error('contact.lifecycle.execute params must be an object');
  assertNoUnknownKeys(input, ['request'], 'contact.lifecycle.execute params');
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'request')) {
    throw new Error('contact.lifecycle.execute requires exactly one request');
  }
  return { request: parseContactAuthorityLifecycleRequest(input.request) };
}

export const contactLifecycleMethodDescriptors: ReadonlyArray<
AuditedMethodDescriptor<unknown, ContactLifecycleExecuteResult>
> = [{
  name: 'contact.lifecycle.execute',
  handler: async (input, runtime) => {
    const params = parseParams(input);
    const companionId = runtime.authenticatedCompanionId();
    if (!companionId) {
      throw new Error('contact.lifecycle.execute requires an authenticated companion connection');
    }
    if (!runtime.contactLifecycleAuthority) {
      throw new Error('Gateway contact lifecycle authority is not configured');
    }
    return parseContactAuthorityLifecycleResult(
      await runtime.contactLifecycleAuthority.executeForCompanion(companionId, params.request),
    );
  },
  summary: input => {
    const params = parseParams(input);
    return {
      intentId: params.request.intentId,
      action: params.request.action,
      phase: params.request.phase,
    };
  },
}];

export function registerContactLifecycleMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, contactLifecycleMethodDescriptors);
}
