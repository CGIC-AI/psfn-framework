import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { gateToolWithCapabilities, type CapabilityAccess } from '../../system/capabilities/gate.js';
import { resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import type { CharacterCardV2 } from './types.js';
import {
  CharacterCardVersionStore,
  createPersonaUpdateTool,
} from './card-versioning.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('');
}

function accessForTier(
  tier: CapabilityTier,
  customTokens: CapabilityToken[] = [],
): CapabilityAccess {
  const granted = new Set(resolveTierCapabilityTokens(tier, customTokens));
  return {
    getTier: () => tier,
    getGrantedTokens: () => granted,
    has: (token) => granted.has(token),
  };
}

const BASE_CARD: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'TestBot',
    description: 'A test character',
    personality: 'Friendly and helpful',
    scenario: 'Testing card changes',
    first_mes: 'Hello there!',
    mes_example: '{{user}}: hi\n{{char}}: hello!',
    system_prompt: 'Be concise.',
    post_history_instructions: 'Stay in character.',
    tags: ['test'],
    creator: 'tester',
  },
};

describe('CharacterCardVersionStore', () => {
  let tempDir: string;
  let cardPath: string;
  let historyPath: string;
  let store: CharacterCardVersionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-card-versioning-'));
    cardPath = join(tempDir, 'character.json');
    historyPath = join(tempDir, 'character-history.jsonl');
    writeFileSync(cardPath, `${JSON.stringify(BASE_CARD, null, 2)}\n`, 'utf-8');
    store = new CharacterCardVersionStore(cardPath, historyPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts at version 1 and appends JSONL history entries on update', () => {
    const initial = store.getCurrent();
    expect(initial.version).toBe(1);

    const updated = store.updateData({ personality: 'Calmer and more reflective' }, 'admin', 'Tune voice');
    expect(updated.version).toBe(2);
    expect(updated.card.data.personality).toBe('Calmer and more reflective');

    const lines = readFileSync(historyPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]) as {
      version: number;
      updatedBy: string;
      reason?: string;
      previousCard: CharacterCardV2;
      newCard: CharacterCardV2;
    };

    expect(entry.version).toBe(1);
    expect(entry.updatedBy).toBe('admin');
    expect(entry.reason).toBe('Tune voice');
    expect(entry.previousCard.data.personality).toBe('Friendly and helpful');
    expect(entry.newCard.data.personality).toBe('Calmer and more reflective');
  });

  it('rolls back to any prior version from history', () => {
    store.updateData({ personality: 'Version 2 personality' }, 'admin');
    store.updateData({ personality: 'Version 3 personality' }, 'admin');

    const rolledBack = store.rollback(1);
    expect(rolledBack.card.data.personality).toBe('Friendly and helpful');
    expect(rolledBack.version).toBe(4);

    const persisted = JSON.parse(readFileSync(cardPath, 'utf-8')) as CharacterCardV2;
    expect(persisted.data.personality).toBe('Friendly and helpful');
  });
});

describe('persona_update tool', () => {
  let tempDir: string;
  let cardPath: string;
  let historyPath: string;
  let store: CharacterCardVersionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-card-tool-'));
    cardPath = join(tempDir, 'character.json');
    historyPath = join(tempDir, 'character-history.jsonl');
    writeFileSync(cardPath, `${JSON.stringify(BASE_CARD, null, 2)}\n`, 'utf-8');
    store = new CharacterCardVersionStore(cardPath, historyPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies low-risk updates immediately in autonomous tier', async () => {
    const tool = gateToolWithCapabilities(
      createPersonaUpdateTool(store, {
        getCapabilityTier: () => 'autonomous',
      }),
      () => accessForTier('autonomous'),
    );

    const result = await tool.execute('tool-call', {
      tags: ['test', 'safe-update'],
      reason: 'Add classification tag',
    });
    const text = resultText(result);

    expect(text).toContain('Updated persona to v2');
    expect(store.getCurrent().card.data.tags).toEqual(['test', 'safe-update']);
  });

  it('fails closed for protected autonomous field edits when no confirmation queue is configured', async () => {
    const longDescription = Array.from({ length: 80 }, (_value, index) => `line ${index}`).join(' ');
    store.updateData({ description: longDescription }, 'admin', 'Seed a long description');

    const tool = gateToolWithCapabilities(
      createPersonaUpdateTool(store, {
        getCapabilityTier: () => 'autonomous',
      }),
      () => accessForTier('autonomous'),
    );

    const result = await tool.execute('tool-call', {
      description: 'Birthday: November 19th, 2023.',
      reason: 'Add birthday',
    });

    expect(resultText(result)).toContain('Protected persona fields require confirmation queue support');
    expect(store.getCurrent().version).toBe(2);
    expect(store.getCurrent().card.data.description).toBe(longDescription);
  });

  it('queues protected autonomous field edits for confirmation instead of applying them', async () => {
    const queue = new ConfirmationQueue({ idFactory: () => 'card-protected-1' });
    const tool = gateToolWithCapabilities(
      createPersonaUpdateTool(store, {
        getCapabilityTier: () => 'autonomous',
        confirmationQueue: queue,
      }),
      () => accessForTier('autonomous'),
    );

    const queued = await tool.execute('tool-call', {
      description: 'Updated protected description',
      reason: 'Refine identity',
    });

    expect(resultText(queued)).toContain('Persona update queued for confirmation');
    expect(resultText(queued)).toContain('Protected identity fields (description)');
    expect(queue.listPending()).toHaveLength(1);
    expect(store.getCurrent().card.data.description).toBe('A test character');

    const resolved = await queue.resolve({
      id: 'card-protected-1',
      decision: 'approve',
    });
    expect(resolved.status).toBe('approved');
    expect(store.getCurrent().card.data.description).toBe('Updated protected description');
  });

  it('queues updates for confirmation in nursery tier and applies after approval', async () => {
    const queue = new ConfirmationQueue({ idFactory: () => 'card-1' });
    const tool = gateToolWithCapabilities(
      createPersonaUpdateTool(store, {
        getCapabilityTier: () => 'nursery',
        confirmationQueue: queue,
      }),
      () => accessForTier('nursery'),
    );

    const queued = await tool.execute('tool-call', {
      personality: 'Queued personality update',
      reason: 'Needs operator review',
    });
    expect(resultText(queued)).toContain('Persona update queued for confirmation');
    expect(queue.listPending()).toHaveLength(1);
    expect(store.getCurrent().card.data.personality).toBe('Friendly and helpful');

    const resolved = await queue.resolve({
      id: 'card-1',
      decision: 'approve',
    });
    expect(resolved.status).toBe('approved');
    expect(store.getCurrent().card.data.personality).toBe('Queued personality update');
  });
});
