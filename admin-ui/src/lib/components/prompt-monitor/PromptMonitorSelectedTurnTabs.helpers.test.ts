import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedTurnTabs } from './PromptMonitorSelectedTurnTabs.helpers';

test('selected-turn navigation keeps four operational views plus preserved diagnostics', () => {
  assert.deepEqual(
    selectedTurnTabs.map(tab => tab.id),
    ['summary', 'blocks', 'context', 'tools', 'diff', 'timing'],
  );
  assert.equal(selectedTurnTabs.some(tab => tab.label === 'Prompt Assembly'), false);
  assert.equal(selectedTurnTabs.some(tab => tab.label === 'Raw Events'), false);
});
