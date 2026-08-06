import { isRfc4122Uuid } from './types.js';

export type UuidExpectation = 'lowercase RFC-4122 UUID' | 'RFC 4122 UUID';
export type UuidRejection = (message: string) => never;

const rejectWithGenericError: UuidRejection = (message) => {
  throw new Error(message);
};

export function requireUuid(
  value: unknown,
  field: string,
  expectationOrReject: UuidExpectation | UuidRejection = 'lowercase RFC-4122 UUID',
  rejectOverride?: UuidRejection,
): string {
  const expectation = typeof expectationOrReject === 'function'
    ? 'lowercase RFC-4122 UUID'
    : expectationOrReject;
  const reject = typeof expectationOrReject === 'function'
    ? expectationOrReject
    : (rejectOverride ?? rejectWithGenericError);
  if (isRfc4122Uuid(value)) return value;
  const article = expectation === 'RFC 4122 UUID' ? 'an' : 'a';
  return reject(`${field} must be ${article} ${expectation}`);
}
