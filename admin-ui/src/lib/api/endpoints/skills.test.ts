import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/errors';
import { skillVersionConflict, updateSkill } from './skills';

afterEach(() => {
  vi.unstubAllGlobals();
});

function conflictBody(): string {
  return JSON.stringify({
    error: 'Skill "gardening" changed since it was read: expected v3, found v5',
    code: 'skill_version_conflict',
    skillName: 'gardening',
    expectedVersion: 3,
    currentVersion: 5,
    reloadRequired: true,
  });
}

describe('managed skill saves', () => {
  it('sends the version the editor was opened against', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await updateSkill({ name: 'gardening', content: '# revised\n', expectedVersion: 3 });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(calls[0]?.[0]).toBe('/api/admin/skills');
    expect(calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ name: 'gardening', content: '# revised\n', expectedVersion: 3 }),
    });
  });

  it('surfaces a lost compare-and-swap as a typed conflict', async () => {
    const fetchMock = vi.fn(async () => new Response(conflictBody(), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await updateSkill({
      name: 'gardening',
      content: '# stale\n',
      expectedVersion: 3,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(skillVersionConflict(error)).toEqual({
      skillName: 'gardening',
      expectedVersion: 3,
      currentVersion: 5,
    });
  });

  it('does not mistake another rejected save for a version conflict', () => {
    expect(skillVersionConflict(new Error('network down'))).toBeNull();
    expect(skillVersionConflict(new ApiError(400, 'Bad Request', '{"error":"name required"}')))
      .toBeNull();
    expect(skillVersionConflict(new ApiError(409, 'Conflict', 'not json'))).toBeNull();
    expect(skillVersionConflict(new ApiError(409, 'Conflict', '{"code":"other_conflict"}')))
      .toBeNull();
  });
});
