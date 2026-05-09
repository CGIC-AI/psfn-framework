// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSettingsSimpleSectionGroups,
  parseSettingsSimpleSectionHash,
  resolveActiveSettingsSimpleSection,
  SETTINGS_IA_GROUPS,
  type SettingsSimpleSectionId,
} from './navigation.ts';

test('settings IA groups stay in required order', () => {
  const groups = buildSettingsSimpleSectionGroups();
  assert.deepEqual(
    groups.map((group) => group.label),
    SETTINGS_IA_GROUPS.map((group) => group.label),
  );
});

test('settings groups keep deterministic section order', () => {
  const groups = buildSettingsSimpleSectionGroups();
  const memory = groups.find((group) => group.id === 'memory');
  const sessions = groups.find((group) => group.id === 'sessions');
  const runtime = groups.find((group) => group.id === 'runtime');
  const trust = groups.find((group) => group.id === 'trust');
  const backups = groups.find((group) => group.id === 'backups');
  const ownerFiles = groups.find((group) => group.id === 'owner-files');
  assert.ok(memory);
  assert.ok(sessions);
  assert.ok(runtime);
  assert.ok(trust);
  assert.ok(backups);
  assert.ok(ownerFiles);
  assert.deepEqual(
    memory.sections.map((section) => section.id),
    ['memory-budget', 'memory-extraction', 'memory-tuning', 'memory-profile'],
  );
  assert.deepEqual(sessions.sections.map((section) => section.id), ['memory-sessions']);
  assert.ok(runtime.sections.some((section) => section.id === 'advanced-fields'));
  assert.deepEqual(trust.sections.map((section) => section.id), ['advanced-trust', 'advanced-secrets']);
  assert.deepEqual(backups.sections.map((section) => section.id), ['advanced-backup']);
  assert.deepEqual(ownerFiles.sections.map((section) => section.id), ['owner-files']);
});

test('group filtering drops empty groups and preserves relative order', () => {
  const include = new Set<SettingsSimpleSectionId>([
    'channels',
    'memory-budget',
    'advanced-trust',
  ]);
  const groups = buildSettingsSimpleSectionGroups({ includeSections: include });
  assert.deepEqual(
    groups.map((group) => group.id),
    ['memory', 'channels', 'trust'],
  );
});

test('hash parsing accepts only known settings section anchors', () => {
  assert.equal(parseSettingsSimpleSectionHash('#settings-memory-budget'), 'memory-budget');
  assert.equal(parseSettingsSimpleSectionHash('#settings-advanced-fields'), 'advanced-fields');
  assert.equal(parseSettingsSimpleSectionHash('#settings-owner-files'), 'owner-files');
  assert.equal(parseSettingsSimpleSectionHash('#settings-missing'), null);
  assert.equal(parseSettingsSimpleSectionHash('#not-settings-memory-budget'), null);
});

test('active section resolution chooses deepest section past threshold', () => {
  const order: SettingsSimpleSectionId[] = [
    'models',
    'channels',
    'memory-budget',
    'runtime-llm',
  ];

  assert.equal(
    resolveActiveSettingsSimpleSection(
      order,
      {
        models: 120,
        channels: 140,
        'memory-budget': 460,
        'runtime-llm': 900,
      },
      160,
    ),
    'channels',
  );

  assert.equal(
    resolveActiveSettingsSimpleSection(
      order,
      {
        models: 280,
        channels: 420,
      },
      160,
    ),
    'models',
  );

  assert.equal(
    resolveActiveSettingsSimpleSection(order, {}, 160),
    null,
  );
});
