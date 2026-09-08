import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { envCredential, type CredentialReference } from '../../shared/contracts/credential-contracts.js';
import {
  parseExternalMemoryBinding,
  type ExternalMemoryBinding,
} from '../../shared/contracts/external-memory.js';

export interface ExternalMemoryApiConfig {
  bindings: Array<ExternalMemoryBinding & { apiKey: string }>;
}

const nonempty = Type.String({ minLength: 1 });
const schema = Type.Object({
  bindings: Type.Array(Type.Object({
    bodyId: nonempty,
    companionId: nonempty,
    contactId: nonempty,
    tokenRef: Type.Object({ kind: Type.Literal('env'), envName: nonempty }, { additionalProperties: false }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

/** Resolve secret references only after validating the complete owner-file section. */
export function parseExternalMemoryConfig(
  input: unknown,
  resolve: (reference: CredentialReference) => string,
): ExternalMemoryApiConfig | undefined {
  if (input === undefined) return undefined;
  if (!Value.Check(schema, input)) throw new Error('Invalid channels.json.api.externalMemory');
  const bodies = new Set<string>();
  const tokens = new Set<string>();
  const bindings = input.bindings.map(({ tokenRef, ...identity }) => {
    const binding = parseExternalMemoryBinding(identity);
    if (Object.values(binding).some(value => value.trim() !== value)) {
      throw new Error('External memory binding identities must not have surrounding whitespace');
    }
    // Garden validates owner files without resolving secrets. The serving route
    // requires every configured credential before it can start.
    const apiKey = resolve(envCredential(tokenRef.envName)).trim();
    if (bodies.has(binding.bodyId) || (apiKey && tokens.has(apiKey))) {
      throw new Error('External memory bindings must have unique body IDs and credentials');
    }
    bodies.add(binding.bodyId);
    if (apiKey) tokens.add(apiKey);
    return { ...binding, apiKey };
  });
  return { bindings };
}
