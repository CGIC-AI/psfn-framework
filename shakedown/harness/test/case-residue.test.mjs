import assert from 'node:assert/strict';
import test from 'node:test';

import {
  restoreContactAfterMutation,
  snapshotContactNotes,
  sweepHarnessContactNote,
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

function fakeContactGarden(contact) {
  const state = { ...contact, channelIdentities: [...(contact.channelIdentities ?? [])] };
  const adminRequest = async (method, path, body) => {
    const detail = /^\/api\/admin\/contacts\/([^/]+)$/u.exec(path);
    const detach = /^\/api\/admin\/contacts\/([^/]+)\/unlink$/u.exec(path);
    if (method === 'GET' && detail) return { ok: true, status: 200, body: { contact: { ...state } } };
    if (method === 'PATCH' && detail) {
      state.notes = body.notes;
      return { ok: true, status: 200, body: {} };
    }
    if (method === 'POST' && detach) {
      state.channelIdentities = state.channelIdentities.filter(
        (entry) => !(entry.channel === body.channel && entry.userId === body.userId),
      );
      return { ok: true, status: 200, body: {} };
    }
    return { ok: false, status: 404, body: null };
  };
  return { state, adminRequest };
}

test('contact_mutation cleanup restores the original notes and detaches the case identity (ob6w1)', async () => {
  const garden = fakeContactGarden({ id: 'contact-api', notes: 'Prefers morning check-ins.', channelIdentities: [{ channel: 'api', userId: 'api-key-x' }] });
  const originalNotes = await snapshotContactNotes({ adminRequest: garden.adminRequest, contactId: 'contact-api' });
  // What the case leaves behind.
  garden.state.notes = 'matrix-note-2026-09-25T06-10-00-000Z';
  garden.state.channelIdentities.push({ channel: 'matrix', userId: 'matrix-user-tok' });

  const result = await restoreContactAfterMutation({
    adminRequest: garden.adminRequest,
    contactId: 'contact-api',
    originalNotes,
    noteToken: 'matrix-note-2026-09-25T06-10-00-000Z',
    linkedUserId: 'matrix-user-tok',
  });
  assert.deepEqual(result.cleanupErrors, []);
  assert.equal(garden.state.notes, 'Prefers morning check-ins.');
  assert.deepEqual(garden.state.channelIdentities, [{ channel: 'api', userId: 'api-key-x' }]);
});

test('a contact restore that does not stick is a cleanup error', async () => {
  const garden = fakeContactGarden({ id: 'c', notes: 'matrix-note-tok', channelIdentities: [] });
  const ignoringPatch = async (method, path, body) => (
    method === 'PATCH' ? { ok: true, status: 200, body: {} } : garden.adminRequest(method, path, body)
  );
  const result = await restoreContactAfterMutation({
    adminRequest: ignoringPatch, contactId: 'c', originalNotes: '', noteToken: 'matrix-note-tok', linkedUserId: 'u',
  });
  assert.ok(result.cleanupErrors.includes('contact notes not restored after cleanup'));
});

test('the startup sweep clears only notes that are exactly a harness marker', async () => {
  const residue = fakeContactGarden({ id: 'c', notes: 'matrix-note-2026-09-24T22-51-02-294Z' });
  assert.equal(await sweepHarnessContactNote({ adminRequest: residue.adminRequest, contactId: 'c' }), true);
  assert.equal(residue.state.notes, '');
  const real = fakeContactGarden({ id: 'c', notes: 'Real notes mentioning matrix-note-x inline.' });
  assert.equal(await sweepHarnessContactNote({ adminRequest: real.adminRequest, contactId: 'c' }), false);
  assert.equal(real.state.notes, 'Real notes mentioning matrix-note-x inline.');
});
