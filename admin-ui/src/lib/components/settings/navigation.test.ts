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
  assert.ok(memory);
  assert.deepEqual(
    memory.sections.map((section) => section.id),
    ['memory-budget', 'memory-extraction', 'memory-sessions', 'memory-tuning', 'memory-profile'],
  );
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
    ['channels', 'memory', 'advanced'],
  );
});

test('hash parsing accepts only known settings section anchors', () => {
  assert.equal(parseSettingsSimpleSectionHash('#settings-memory-budget'), 'memory-budget');
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
