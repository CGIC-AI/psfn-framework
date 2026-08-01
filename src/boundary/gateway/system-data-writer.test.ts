import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readToolConformanceLatest } from '../../core/agent/tool-conformance/store.js';
import { GatewaySystemDataWriter, parseSystemDataWriteRequest } from './system-data-writer.js';

describe('GatewaySystemDataWriter', () => {
  const tempDirs: string[] = [];

  function makeWriter(systemDataDir: string): GatewaySystemDataWriter {
    return new GatewaySystemDataWriter({
      configStore: {
        saveRuntimeSettings: vi.fn(),
        saveModels: vi.fn(),
        saveProviders: vi.fn(),
        saveChannelsOwnerFile: vi.fn(),
        saveTrustPolicy: vi.fn(),
        saveIntakePolicy: vi.fn(),
        savePartnerAffectShadow: vi.fn(),
        saveBackup: vi.fn(),
        saveMcpServers: vi.fn(),
      },
      systemDataDir,
    });
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dispatches a validated system owner payload to the gateway-owned config store', async () => {
    const saveBackup = vi.fn();
    const writer = new GatewaySystemDataWriter({
      configStore: {
        saveRuntimeSettings: vi.fn(),
        saveModels: vi.fn(),
        saveProviders: vi.fn(),
        saveChannelsOwnerFile: vi.fn(),
        saveTrustPolicy: vi.fn(),
        saveIntakePolicy: vi.fn(),
        savePartnerAffectShadow: vi.fn(),
        saveBackup,
        saveMcpServers: vi.fn(),
      },
      systemDataDir: '/unused',
    });

    await expect(writer.writeSystemData({
      kind: 'owner_file',
      ownerFile: 'backup',
      payload: { intervalHours: 24 },
    })).resolves.toEqual({ ok: true });
    expect(saveBackup).toHaveBeenCalledWith({ intervalHours: 24 });
  });

  it('rejects unknown settings keys before the gateway-owned config store can persist them', async () => {
    const saveRuntimeSettings = vi.fn();
    const writer = new GatewaySystemDataWriter({
      configStore: {
        saveRuntimeSettings,
        saveModels: vi.fn(),
        saveProviders: vi.fn(),
        saveChannelsOwnerFile: vi.fn(),
        saveTrustPolicy: vi.fn(),
        saveIntakePolicy: vi.fn(),
        savePartnerAffectShadow: vi.fn(),
        saveBackup: vi.fn(),
        saveMcpServers: vi.fn(),
      },
      systemDataDir: '/unused',
    });

    await expect(writer.writeSystemData({
      kind: 'owner_file',
      ownerFile: 'settings',
      payload: { unknownPolicy: true },
    })).rejects.toThrow(/unknown keys.*unknownPolicy/);
    expect(saveRuntimeSettings).not.toHaveBeenCalled();
  });

  it('persists conformance latest/history beneath the gateway writable system-data root', async () => {
    const systemDataDir = mkdtempSync(join(tmpdir(), 'psfn-gateway-system-write-'));
    tempDirs.push(systemDataDir);
    const writer = new GatewaySystemDataWriter({
      configStore: {
        saveRuntimeSettings: vi.fn(),
        saveModels: vi.fn(),
        saveProviders: vi.fn(),
        saveChannelsOwnerFile: vi.fn(),
        saveTrustPolicy: vi.fn(),
        saveIntakePolicy: vi.fn(),
        savePartnerAffectShadow: vi.fn(),
        saveBackup: vi.fn(),
        saveMcpServers: vi.fn(),
      },
      systemDataDir,
    });
    const payload = {
      schemaVersion: 1 as const,
      ranAt: 1_700_000_000_000,
      trigger: 'manual' as const,
      results: [{
        toolName: 'session_list',
        probeKind: 'read_only' as const,
        ok: true,
        durationMs: 2,
      }],
    };

    await writer.writeSystemData({ kind: 'tool_conformance', payload });

    expect(readToolConformanceLatest(systemDataDir)).toEqual(payload);
  });

  it('persists the validated satellite registry beneath the gateway writable root', async () => {
    const systemDataDir = mkdtempSync(join(tmpdir(), 'psfn-gateway-satellites-write-'));
    tempDirs.push(systemDataDir);
    const writer = makeWriter(systemDataDir);
    const payload = {
      schemaVersion: 1 as const,
      enabled: false,
      satellites: [],
    };

    await expect(writer.writeSystemData({
      kind: 'satellites',
      payload,
    })).resolves.toEqual({ ok: true });

    expect(JSON.parse(readFileSync(join(systemDataDir, 'satellites.json'), 'utf8')))
      .toEqual(payload);
  });

  it('contains shared-world wiki writes to the gateway-owned site tree', async () => {
    const systemDataDir = mkdtempSync(join(tmpdir(), 'psfn-gateway-wiki-write-'));
    tempDirs.push(systemDataDir);
    writeFileSync(join(systemDataDir, 'places.json'), JSON.stringify({
      schemaVersion: 1,
      sites: [{ siteId: 'home', displayName: 'Home', kind: 'physical' }],
      places: [],
    }), 'utf8');
    const writer = makeWriter(systemDataDir);

    await expect(writer.writeSystemData({
      kind: 'shared_world_wiki',
      operation: 'publish_site',
      siteId: 'home',
      updatedBy: 'garden-operator',
    })).resolves.toEqual({
      ok: true,
      kind: 'shared_world_wiki',
      operation: 'publish_site',
      report: {
        siteId: 'home',
        created: ['site-overview'],
        updated: [],
        unchanged: [],
        deleted: [],
      },
    });
    expect(existsSync(join(
      systemDataDir,
      'shared-world',
      'wiki',
      'sites',
      'home',
      'documents',
      'site-overview.md',
    ))).toBe(true);

    await expect(writer.writeSystemData({
      kind: 'shared_world_wiki',
      operation: 'upsert_document',
      siteId: '../escape',
      document: {
        id: 'escaped',
        title: 'Escaped',
        body: 'This must not be written.',
      },
    })).rejects.toThrow(/siteId|outside|scope/u);
    expect(existsSync(join(systemDataDir, 'escape'))).toBe(false);
  });

  it('rejects unknown owner names and caller-supplied identity fields', () => {
    expect(() => parseSystemDataWriteRequest({
      kind: 'owner_file',
      ownerFile: 'scheduler',
      payload: {},
    })).toThrow(/mutable system owner/);
    expect(() => parseSystemDataWriteRequest({
      kind: 'tool_conformance',
      payload: {
        schemaVersion: 1,
        ranAt: 1,
        trigger: 'manual',
        results: [],
      },
      companionId: 'spoofed',
    })).toThrow(/unknown keys/);
    expect(() => parseSystemDataWriteRequest({
      kind: 'shared_world_wiki',
      operation: 'publish_site',
      siteId: 'home',
      updatedBy: '   ',
    })).toThrow(/updatedBy must be non-empty/);
  });

  it('accepts an empty conformance error string from the canonical harness contract', () => {
    expect(parseSystemDataWriteRequest({
      kind: 'tool_conformance',
      payload: {
        schemaVersion: 1,
        ranAt: 1,
        trigger: 'manual',
        results: [{
          toolName: 'memory',
          probeKind: 'read_only',
          ok: false,
          durationMs: 1,
          classification: 'returned_error',
          error: '',
        }],
      },
    })).toMatchObject({
      kind: 'tool_conformance',
      payload: {
        results: [{ classification: 'returned_error', error: '' }],
      },
    });
  });
});
