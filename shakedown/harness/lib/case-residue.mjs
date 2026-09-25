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

export const HARNESS_CONTACT_NOTE_PREFIX = 'matrix-note-';
const HARNESS_LINKED_CHANNEL = 'matrix';
const HARNESS_CONTACT_NOTE_ONLY = /^matrix-note-\S+$/u;

function contactOf(detailBody) {
  const contact = detailBody?.contact;
  if (!contact || typeof contact !== 'object') throw new Error('contact detail must contain a contact');
  return contact;
}

function hasLinkedHarnessIdentity(contact, userId) {
  const identities = [
    ...(Array.isArray(contact.channelIdentities) ? contact.channelIdentities : []),
    ...(Array.isArray(contact.channels) ? contact.channels : []),
  ];
  return identities.some((entry) => entry?.channel === HARNESS_LINKED_CHANNEL && entry?.userId === userId);
}

function contactPath(contactId) {
  return `/api/admin/contacts/${encodeURIComponent(contactId)}`;
}

/**
 * contact_mutation replaces the primary contact's notes with a
 * `matrix-note-<token>` marker and links a `matrix` identity; nothing restored
 * them, so the marker stayed on the API contact across rounds
 * (psfn-framework-ob6w1). The case snapshots the notes before dispatch; its
 * cleanup restores them, detaches the case identity, and proves both.
 */
export async function snapshotContactNotes({ adminRequest, contactId }) {
  const detail = await adminRequest('GET', contactPath(contactId));
  if (!detail?.ok) throw new Error(`contact snapshot unavailable (${detail?.status ?? 'no response'})`);
  const notes = contactOf(detail.body).notes;
  return typeof notes === 'string' ? notes : '';
}

export async function restoreContactAfterMutation({ adminRequest, contactId, originalNotes, noteToken, linkedUserId }) {
  if (!noteToken.startsWith(HARNESS_CONTACT_NOTE_PREFIX)) {
    throw new Error(`refusing to restore contact notes for non-harness token ${noteToken}`);
  }
  const cleanupErrors = [];
  const path = contactPath(contactId);
  const current = await adminRequest('GET', path);
  if (!current?.ok) {
    return { cleanup: {}, cleanupErrors: [`contact detail unavailable (${current?.status ?? 'no response'})`] };
  }
  const contact = contactOf(current.body);
  if ((contact.notes ?? '') !== originalNotes) {
    const patched = await adminRequest('PATCH', path, { notes: originalNotes });
    if (!patched?.ok) cleanupErrors.push(`could not restore contact notes (${patched?.status ?? 'no response'})`);
  }
  if (hasLinkedHarnessIdentity(contact, linkedUserId)) {
    const detached = await adminRequest('POST', `${path}/unlink`, { channel: HARNESS_LINKED_CHANNEL, userId: linkedUserId });
    if (!detached?.ok) cleanupErrors.push(`could not detach the ${HARNESS_LINKED_CHANNEL} identity (${detached?.status ?? 'no response'})`);
  }
  const verify = await adminRequest('GET', path);
  if (!verify?.ok) {
    cleanupErrors.push('contact detail unavailable for post-cleanup verification');
  } else {
    const verified = contactOf(verify.body);
    if ((verified.notes ?? '') !== originalNotes) cleanupErrors.push('contact notes not restored after cleanup');
    if (hasLinkedHarnessIdentity(verified, linkedUserId)) {
      cleanupErrors.push(`${HARNESS_LINKED_CHANNEL} identity still attached after cleanup`);
    }
  }
  return { cleanup: { notesRestored: cleanupErrors.length === 0 }, cleanupErrors };
}

/**
 * Earlier runs left the contact's notes as a bare harness marker. At startup
 * a notes value that is exactly one marker is cleared (the original was
 * overwritten and cannot be recovered); returns true when it was cleared.
 */
export async function sweepHarnessContactNote({ adminRequest, contactId }) {
  const path = contactPath(contactId);
  const detail = await adminRequest('GET', path);
  if (!detail?.ok) throw new Error(`contact detail unavailable (${detail?.status ?? 'no response'})`);
  const notes = contactOf(detail.body).notes;
  if (typeof notes !== 'string' || !HARNESS_CONTACT_NOTE_ONLY.test(notes.trim())) return false;
  const patched = await adminRequest('PATCH', path, { notes: '' });
  if (!patched?.ok) throw new Error(`could not clear harness contact note residue (${patched?.status ?? 'no response'})`);
  const verify = await adminRequest('GET', path);
  if (!verify?.ok || (contactOf(verify.body).notes ?? '') !== '') {
    throw new Error('harness contact note residue still present after the sweep');
  }
  return true;
}
