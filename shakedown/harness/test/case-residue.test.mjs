import assert from 'node:assert/strict';
import test from 'node:test';

import {
  removeHarnessSkill,
  scratchpadRoundTripFailures,
  sweepHarnessSkills,
  verifyScratchpadNoteRemoved,
} from '../lib/case-residue.mjs';

function fakeSkillsGarden(names) {
  const skills = new Set(names);
  const calls = [];
  const adminRequest = async (method, path) => {
    calls.push({ method, path });
    if (method === 'GET' && path === '/api/admin/skills') {
      return { ok: true, status: 200, body: { managed: [...skills].map((name) => ({ name })) } };
    }
    const match = /^\/api\/admin\/skills\/(.+)$/u.exec(path);
    if (method === 'DELETE' && match) {
      skills.delete(decodeURIComponent(match[1]));
      return { ok: true, status: 200, body: { ok: true } };
    }
    return { ok: false, status: 404, body: null };
  };
  return { skills, calls, adminRequest };
}

test('the skill_manage cleanup deletes the case skill and proves it absent', async () => {
  const garden = fakeSkillsGarden(['matrix-runbook-2026-09-25t03-30-06-336z', 'companion-own-skill']);
  const result = await removeHarnessSkill({
    adminRequest: garden.adminRequest,
    name: 'matrix-runbook-2026-09-25t03-30-06-336z',
  });
  assert.deepEqual(result.cleanupErrors, []);
  assert.equal(result.cleanup.absent, true);
  assert.deepEqual([...garden.skills], ['companion-own-skill']);
});

test('a skill that survives deletion is a cleanup error', async () => {
  const garden = fakeSkillsGarden(['matrix-runbook-x']);
  const stubborn = async (method, path) => (
    method === 'DELETE' ? { ok: true, status: 200, body: {} } : garden.adminRequest(method, path)
  );
  const result = await removeHarnessSkill({ adminRequest: stubborn, name: 'matrix-runbook-x' });
  assert.ok(result.cleanupErrors.some((error) => error.includes('still present')));
});

test('cleanup refuses to delete a non-harness skill', async () => {
  const garden = fakeSkillsGarden(['companion-own-skill']);
  await assert.rejects(
    removeHarnessSkill({ adminRequest: garden.adminRequest, name: 'companion-own-skill' }),
    /non-harness skill/u,
  );
});

test('the startup sweep removes only earlier harness skills', async () => {
  const garden = fakeSkillsGarden(['matrix-runbook-a', 'matrix-runbook-b', 'companion-own-skill']);
  const removed = await sweepHarnessSkills({ adminRequest: garden.adminRequest });
  assert.deepEqual(removed.sort(), ['matrix-runbook-a', 'matrix-runbook-b']);
  assert.deepEqual([...garden.skills], ['companion-own-skill']);
});

test('the scratchpad round trip requires add, list, and remove of the same note', () => {
  const token = 'matrix-scratch-tok';
  const tool = (contentText) => ({ toolName: 'scratchpad', isError: false, contentText });
  const full = [
    tool('Scratchpad entry added (id: sp-9). Keep temporary working context here.'),
    tool(`Scratchpad entries (1) [24h ephemeral working context]:\n- sp-9 [t]: ${token}`),
    tool('Scratchpad entry removed (id: sp-9).'),
  ];
  assert.deepEqual(scratchpadRoundTripFailures(full, token), []);
  assert.deepEqual(
    scratchpadRoundTripFailures(full.slice(0, 2), token),
    ['scratchpad_roundtrip must remove the note it added'],
  );
  assert.deepEqual(
    scratchpadRoundTripFailures([], token),
    ['scratchpad_roundtrip must add the note', 'scratchpad_roundtrip must list the note it added'],
  );
});

test('a scratchpad note left in Postgres after the case is a cleanup error', async () => {
  const token = 'matrix-scratch-tok';
  const present = await verifyScratchpadNoteRemoved({ pgAll: async () => [{ id: 'sp-9' }], token });
  assert.deepEqual(present.cleanupErrors, [`scratchpad note ${token} still present after the case`]);
  const gone = await verifyScratchpadNoteRemoved({
    pgAll: async (sql, params) => {
      assert.match(sql, /where content like \$1/u);
      assert.deepEqual(params, [`%${token}%`]);
      return [];
    },
    token,
  });
  assert.deepEqual(gone.cleanupErrors, []);
});
