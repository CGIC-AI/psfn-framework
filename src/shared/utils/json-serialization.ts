import { isRecord } from './types.js';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

const stringifyJson: (value: unknown) => string | undefined = JSON.stringify;

/**
 * Project a value through the same semantics as a JSON persistence or wire
 * boundary. Object properties whose value is `undefined` are omitted, array
 * holes and unsupported array entries become `null`, and `Date` values become
 * ISO strings. Values without a root JSON representation fail loudly.
 */
export function normalizeJsonValueForSerialization(
  value: unknown,
  fieldName = 'value',
): JsonValue {
  const serialized = stringifyJson(value);
  if (serialized === undefined) {
    throw new TypeError(`${fieldName} cannot be represented as JSON`);
  }
  return JSON.parse(serialized) as JsonValue;
}

/** JSON-boundary projection that additionally requires an object result. */
export function normalizeJsonRecordForSerialization(
  value: object,
  fieldName = 'value',
): JsonObject {
  const normalized = normalizeJsonValueForSerialization(value, fieldName);
  if (!isRecord(normalized)) {
    throw new TypeError(`${fieldName} must serialize to a JSON object`);
  }
  return normalized;
}
