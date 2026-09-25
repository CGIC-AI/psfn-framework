/**
 * Harness-owned cleanup for Layer A case residue (psfn-framework-ob6w1).
 *
 * skill_manage created `matrix-runbook-<token>` managed skills and
 * scratchpad_roundtrip left `matrix-scratch-<token>` notes; nothing removed
 * them, so they accumulated in the companion's skills index and scratchpad
 * across rounds. Skills are removed through the Garden admin API after the
 * case (and swept at startup). The scratchpad case is now a real round trip
 * (add, list, remove) and the harness proves the note is gone from Postgres;
 * the running agent's scratchpad cannot be edited from outside, so a note the
 * companion failed to remove is a case failure, never silent residue.
 */

export const HARNESS_SKILL_PREFIX = 'matrix-runbook-';
export const HARNESS_SCRATCHPAD_PREFIX = 'matrix-scratch-';

function managedSkillNames(listBody) {
  if (!listBody || !Array.isArray(listBody.managed)) {
    throw new Error('managed skill inventory must contain a managed array');
  }
  return listBody.managed
    .map((skill) => skill?.name)
    .filter((name) => typeof name === 'string');
}

async function deleteSkills({ adminRequest, names }) {
  const cleanupErrors = [];
  const removed = [];
  for (const name of names) {
    const deleted = await adminRequest('DELETE', `/api/admin/skills/${encodeURIComponent(name)}`);
    if (deleted?.ok) removed.push(name);
    else cleanupErrors.push(`could not delete managed skill ${name} (${deleted?.status ?? 'no response'})`);
  }
  return { removed, cleanupErrors };
}

/** Remove the case's skill and prove it is gone (case-cleanup contract). */
export async function removeHarnessSkill({ adminRequest, name }) {
  if (!name.startsWith(HARNESS_SKILL_PREFIX)) {
    throw new Error(`refusing to delete non-harness skill ${name}`);
  }
  const listed = await adminRequest('GET', '/api/admin/skills');
  if (!listed?.ok) {
    return { cleanup: { removed: [] }, cleanupErrors: [`skill inventory unavailable (${listed?.status ?? 'no response'})`] };
  }
  const present = managedSkillNames(listed.body).includes(name);
  const { removed, cleanupErrors } = present ? await deleteSkills({ adminRequest, names: [name] }) : { removed: [], cleanupErrors: [] };
  const verify = await adminRequest('GET', '/api/admin/skills');
  if (!verify?.ok) {
    cleanupErrors.push('skill inventory unavailable for post-cleanup verification');
  } else if (managedSkillNames(verify.body).includes(name)) {
    cleanupErrors.push(`managed skill ${name} still present after cleanup`);
  }
  return { cleanup: { removed, absent: cleanupErrors.length === 0 }, cleanupErrors };
}

/** Delete harness skills earlier runs left behind; returns the removed names. */
export async function sweepHarnessSkills({ adminRequest }) {
  const listed = await adminRequest('GET', '/api/admin/skills');
  if (!listed?.ok) throw new Error(`skill inventory unavailable (${listed?.status ?? 'no response'})`);
  const stale = managedSkillNames(listed.body).filter((name) => name.startsWith(HARNESS_SKILL_PREFIX));
  const { removed, cleanupErrors } = await deleteSkills({ adminRequest, names: stale });
  if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join('; '));
  return removed;
}

function toolText(entry) {
  if (typeof entry?.contentText === 'string') return entry.contentText;
  return typeof entry?.contentPreview === 'string' ? entry.contentPreview : '';
}

/**
 * Proof that the companion added, listed, and removed the case note, from the
 * persisted tool results.
 */
export function scratchpadRoundTripFailures(archiveToolMessages, token) {
  const results = (Array.isArray(archiveToolMessages) ? archiveToolMessages : [])
    .filter((entry) => entry?.toolName === 'scratchpad' && entry?.isError !== true)
    .map(toolText);
  const added = results.map((text) => /Scratchpad entry added \(id: ([^)]+)\)/u.exec(text)?.[1]).find(Boolean);
  const failures = [];
  if (!added) failures.push('scratchpad_roundtrip must add the note');
  if (!results.some((text) => text.includes(token))) failures.push('scratchpad_roundtrip must list the note it added');
  if (added && !results.some((text) => text.includes(`Scratchpad entry removed (id: ${added})`))) {
    failures.push('scratchpad_roundtrip must remove the note it added');
  }
  return failures;
}

/** Case-cleanup contract: the note must be gone from Postgres after the case. */
export async function verifyScratchpadNoteRemoved({ pgAll, token }) {
  if (!token.startsWith(HARNESS_SCRATCHPAD_PREFIX)) {
    throw new Error(`refusing to inspect non-harness scratchpad token ${token}`);
  }
  const rows = await pgAll('select id from scratchpad_entries where content like $1', [`%${token}%`]);
  return {
    cleanup: { remainingNoteIds: rows.map((row) => row.id) },
    cleanupErrors: rows.length > 0 ? [`scratchpad note ${token} still present after the case`] : [],
  };
}

/** Count scratchpad residue from earlier runs (read-only; reported, not deleted). */
export async function countHarnessScratchpadResidue({ pgAll }) {
  const rows = await pgAll('select id from scratchpad_entries where content like $1', [`${HARNESS_SCRATCHPAD_PREFIX}%`]);
  return rows.length;
}
