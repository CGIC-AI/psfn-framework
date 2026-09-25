/**
 * Harness-owned restoration of prompt layers mutated by prompt_* cases
 * (psfn-framework-2pz3o). prompt_mutation_cycle asks the companion to append a
 * "[matrix prompt marker <token>]" line and roll it back; when the rollback did
 * not restore the original content the marker stayed in the runtime prompt
 * layer and rendered into every later turn. The case now snapshots the layers
 * before dispatch, restores any changed content/enabled state through the
 * Garden admin API afterwards, and proves the layers byte-identical.
 */

const HARNESS_MARKER_LINE = /\r?\n?\[matrix prompt marker [^\]\r\n]+\][ \t]*(?=\r?\n|$)/gu;

function layersOf(listBody) {
  if (!listBody || !Array.isArray(listBody.layers)) {
    throw new Error('prompt layer inventory must contain a layers array');
  }
  return listBody.layers;
}

/** Content and enabled state of every layer, keyed by id. */
export function snapshotPromptLayers(listBody) {
  const snapshot = new Map();
  for (const layer of layersOf(listBody)) {
    if (typeof layer?.id !== 'string' || typeof layer?.content !== 'string' || typeof layer?.enabled !== 'boolean') {
      throw new Error('prompt layer inventory entry is missing id, content, or enabled');
    }
    snapshot.set(layer.id, { content: layer.content, enabled: layer.enabled });
  }
  return snapshot;
}

/** Layers whose content or enabled state differs from the snapshot. */
export function diffPromptLayers(before, afterListBody) {
  const after = snapshotPromptLayers(afterListBody);
  const changes = [];
  for (const [id, original] of before) {
    const current = after.get(id);
    if (!current) {
      changes.push({ id, missing: true });
      continue;
    }
    const contentChanged = current.content !== original.content;
    const enabledChanged = current.enabled !== original.enabled;
    if (contentChanged || enabledChanged) {
      changes.push({ id, contentChanged, enabledChanged, original });
    }
  }
  for (const id of after.keys()) {
    if (!before.has(id)) changes.push({ id, added: true });
  }
  return changes;
}

/** Content with every harness marker line removed, or null when there is none. */
export function stripHarnessPromptMarkers(content) {
  const stripped = content.replace(HARNESS_MARKER_LINE, '');
  return stripped === content ? null : stripped;
}

/**
 * Restore mutated layers and verify. `adminRequest(method, path, body?)` returns
 * the harness fetchJson result. Returns the case-cleanup contract
 * ({ cleanup, cleanupErrors }).
 */
export async function restorePromptLayers({ before, adminRequest }) {
  const cleanupErrors = [];
  const restored = [];
  const listed = await adminRequest('GET', '/api/admin/prompts');
  if (!listed?.ok) {
    return { cleanup: { restored }, cleanupErrors: [`prompt inventory unavailable (${listed?.status ?? 'no response'})`] };
  }
  for (const change of diffPromptLayers(before, listed.body)) {
    if (change.missing || change.added) {
      cleanupErrors.push(`prompt layer ${change.id} was ${change.missing ? 'removed' : 'added'} by the case`);
      continue;
    }
    if (change.contentChanged) {
      const patched = await adminRequest('PATCH', `/api/admin/prompts/${encodeURIComponent(change.id)}`, {
        content: change.original.content,
      });
      if (!patched?.ok) cleanupErrors.push(`could not restore prompt layer ${change.id} content`);
    }
    if (change.enabledChanged) {
      const toggled = await adminRequest('POST', `/api/admin/prompts/${encodeURIComponent(change.id)}/toggle`);
      if (!toggled?.ok) cleanupErrors.push(`could not restore prompt layer ${change.id} enabled state`);
    }
    restored.push({ id: change.id, content: change.contentChanged, enabled: change.enabledChanged });
  }
  const verify = await adminRequest('GET', '/api/admin/prompts');
  const residual = verify?.ok ? diffPromptLayers(before, verify.body) : null;
  if (residual === null) {
    cleanupErrors.push('prompt inventory unavailable for post-restore verification');
  } else if (residual.length > 0) {
    cleanupErrors.push(`prompt layers not byte-identical after restore: ${residual.map((change) => change.id).join(', ')}`);
  }
  return {
    cleanup: { restored, byteIdentical: residual !== null && residual.length === 0 },
    cleanupErrors,
  };
}

/**
 * Remove marker residue left by earlier runs before this run snapshots the
 * layers, so a pre-fix round's leftovers do not become the restore baseline.
 */
export async function sweepHarnessPromptMarkers({ adminRequest }) {
  const listed = await adminRequest('GET', '/api/admin/prompts');
  if (!listed?.ok) throw new Error(`prompt inventory unavailable (${listed?.status ?? 'no response'})`);
  const swept = [];
  for (const layer of layersOf(listed.body)) {
    const stripped = typeof layer?.content === 'string' ? stripHarnessPromptMarkers(layer.content) : null;
    if (stripped === null) continue;
    const patched = await adminRequest('PATCH', `/api/admin/prompts/${encodeURIComponent(layer.id)}`, { content: stripped });
    if (!patched?.ok) throw new Error(`could not remove harness marker residue from prompt layer ${layer.id}`);
    swept.push(layer.id);
  }
  return swept;
}
