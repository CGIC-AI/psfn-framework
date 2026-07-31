function rowsContainText(rows, expectedText) {
  return typeof expectedText === 'string'
    && expectedText.length > 0
    && JSON.stringify(rows ?? []).includes(expectedText);
}

export function buildMemoryTierCases(ctx, { pgAll }) {
  const memoryInitial = `matrix-memory-${ctx.runToken}`;
  const memoryPatched = `matrix-memory-patched-${ctx.runToken}`;
  const memoryDeleteText = `autonomous-memory-delete-${ctx.runToken}`;

  return {
    apprentice: [{
      id: 'memory_write_patch',
      sessionId: `apprentice-memory-${ctx.runToken}`,
      expectedTools: ['memory'],
      actionSensitive: true,
      actionSuccessKeys: [],
      message:
        `First call memory with action "write", text "${memoryInitial}", type "semantic", sensitivity "personal". `
        + 'Use the returned memory id. '
        + `Then call memory with action "patch", memory_id set to that id, text "${memoryPatched}", and reason "shakedown patch". `
        + 'Do not substitute any other tool. If a direct tool call fails, report the exact tool error. '
        + 'Return only a JSON object with key memoryId.',
      validateParsedAssistant: ({ parsedAssistant }) => {
        const failures = [];
        if (typeof parsedAssistant?.memoryId !== 'string' || parsedAssistant.memoryId.trim().length === 0) {
          failures.push('memory_write_patch memoryId must be a non-empty string');
        }
        return failures;
      },
      timeoutMs: 180000,
      after: async () => ({
        memoryRows: await pgAll(
          `select id, text, deleted_at, source_ref from l2_memories where text like '%${memoryInitial}%' or text like '%${memoryPatched}%';`,
        ),
        patchRows: await pgAll(
          `select p.memory_id, p.reason, p.source_ref, p.created_at from l2_memory_patch_events p join l2_memories m on m.id = p.memory_id where m.text like '%${memoryPatched}%' order by p.created_at desc limit 5;`,
        ),
      }),
      validateSideEffects: ({ sideChecks }) => {
        const failures = [];
        if (!rowsContainText(sideChecks?.memoryRows, memoryPatched)) {
          failures.push('memory_write_patch must persist the patched memory text');
        }
        if (!Array.isArray(sideChecks?.patchRows) || sideChecks.patchRows.length === 0) {
          failures.push('memory_write_patch must persist its own patch journal row');
        }
        return failures;
      },
    }],
    autonomous: [{
      id: 'memory_delete_restore',
      sessionId: `autonomous-memory-delete-${ctx.runToken}`,
      expectedTools: ['memory'],
      actionSensitive: true,
      actionSuccessKeys: ['deleted', 'restored'],
      message:
        `First call memory with action "write", text "${memoryDeleteText}", type "semantic", sensitivity "personal". `
        + 'Use the returned memory id. '
        + 'Then call memory with action "delete" on that same id with reason "autonomous shakedown delete". '
        + 'Use the returned delete_id to call memory with action "restore". '
        + 'Do not substitute any other tool. If a direct tool call fails, report the exact tool error. '
        + 'Return only a JSON object with keys memoryId, deleteId, deleted, and restored.',
      validateParsedAssistant: ({ parsedAssistant }) => {
        const failures = [];
        if (typeof parsedAssistant?.memoryId !== 'string' || parsedAssistant.memoryId.trim().length === 0) {
          failures.push('memory_delete_restore memoryId must be a non-empty string');
        }
        if (typeof parsedAssistant?.deleteId !== 'string' || parsedAssistant.deleteId.trim().length === 0) {
          failures.push('memory_delete_restore deleteId must be a non-empty string');
        }
        return failures;
      },
      timeoutMs: 180000,
      after: async () => ({
        memoryRows: await pgAll(
          `select id, text, deleted_at, source_ref from l2_memories where text like '%${memoryDeleteText}%';`,
        ),
        deleteRows: await pgAll(
          `select d.delete_id, d.memory_id, d.delete_reason, d.restored_at, d.restored_by from l2_memory_delete_versions d join l2_memories m on m.id = d.memory_id where m.text like '%${memoryDeleteText}%' order by d.deleted_at desc limit 5;`,
        ),
      }),
      validateSideEffects: ({ sideChecks }) => {
        const failures = [];
        if (!Array.isArray(sideChecks?.memoryRows) || sideChecks.memoryRows.length === 0) {
          failures.push('memory_delete_restore must retain its restored memory row');
        }
        if (
          !Array.isArray(sideChecks?.deleteRows)
          || !sideChecks.deleteRows.some((row) => row?.restored_at || row?.restoredAt)
        ) {
          failures.push('memory_delete_restore must persist its own restored delete journal row');
        }
        return failures;
      },
    }],
  };
}
