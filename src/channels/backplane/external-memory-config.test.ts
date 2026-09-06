import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadChannelsOwnerFile, loadRuntimeChannelsConfig } from './config.js';
import { createStaticCredentialVault } from '../../boundary/custody/credential-vault.js';

const directories: string[] = [];
const binding = {
  bodyId: 'hermes-work', companionId: '11111111-1111-4111-8111-111111111111', contactId: 'contact-operator',
  tokenRef: { kind: 'env', envName: 'HERMES_MEMORY_TOKEN' },
};
function ownerFile(externalMemory: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'psfn-external-memory-config-'));
  directories.push(directory);
  writeFileSync(join(directory, 'channels.json'), JSON.stringify({ api: { externalMemory } }));
  return directory;
}
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('external memory channel configuration', () => {
  it('loads fixed bindings using existing credential custody and retains only refs in the owner file', () => {
    const configured = { bindings: [binding] };
    const directory = ownerFile(configured);
    const config = loadRuntimeChannelsConfig(directory, {}, {}, {
      credentialVault: createStaticCredentialVault({ HERMES_MEMORY_TOKEN: 'dedicated-memory-key' }),
    });
    expect(config.api.externalMemory).toEqual({ bindings: [{
      bodyId: binding.bodyId, companionId: binding.companionId, contactId: binding.contactId, apiKey: 'dedicated-memory-key',
    }] });
    expect(loadChannelsOwnerFile(directory)).toEqual({ api: { externalMemory: configured } });
    expect(config.api.testingHarness).toBeUndefined();
  });

  it('leaves the service disabled when absent or explicitly empty', () => {
    expect(loadRuntimeChannelsConfig(ownerFile(undefined), {}).api.externalMemory).toBeUndefined();
    expect(loadRuntimeChannelsConfig(ownerFile({ bindings: [] }), {}).api.externalMemory).toEqual({ bindings: [] });
  });

  it.each([
    null,
    { enabled: true, bindings: [] },
    { bindings: [{ ...binding, token: 'inline-secret' }] },
    { bindings: [{ ...binding, role: 'admin' }] },
    { bindings: [{ ...binding, tokenRef: { ...binding.tokenRef, secret: 'inline-secret' } }] },
    { bindings: [{ ...binding, companionId: 'not-a-uuid' }] },
    { bindings: [{ ...binding, contactId: '' }] },
    { bindings: [{ ...binding, bodyId: ' ambiguous ' }] },
    { bindings: [{ ...binding, tokenRef: { kind: 'env', envName: 'lowercase-name' } }] },
  ])('rejects malformed or extra authority fields: %j', invalid => {
    expect(() => loadRuntimeChannelsConfig(ownerFile(invalid), { HERMES_MEMORY_TOKEN: 'dedicated-memory-key' })).toThrow();
  });

  it('defers missing-secret rejection to route startup and rejects ambiguous bindings', () => {
    expect(loadRuntimeChannelsConfig(ownerFile({ bindings: [binding] }), {}).api.externalMemory?.bindings[0]?.apiKey).toBe('');
    const another = { ...binding, bodyId: 'another-body' };
    expect(() => loadRuntimeChannelsConfig(ownerFile({ bindings: [binding, another] }), { HERMES_MEMORY_TOKEN: 'same-key' })).toThrow('unique');
    expect(() => loadRuntimeChannelsConfig(ownerFile({ bindings: [binding, { ...binding, tokenRef: { kind: 'env', envName: 'OTHER_TOKEN' } }] }), {
      HERMES_MEMORY_TOKEN: 'first-key', OTHER_TOKEN: 'second-key',
    })).toThrow('unique');
  });
});
