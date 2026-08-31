function rowsContainText(rows, expectedText) {
  return typeof expectedText === 'string'
    && expectedText.length > 0
    && JSON.stringify(rows ?? []).includes(expectedText);
}

export function buildMemoryTierCases(ctx, {
  adminBase,
  approveOperatorConfirmation,
  chatCase,
  fetchJson,
  pgAll,
}) {
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
      message: 'Current memory deletion is an Operator-validated two-turn workflow.',
      execute: async ({ sessionId, apiUserId, signal }) => {
        const proposalTurn = await chatCase({
          sessionId,
          apiUserId,
          signal,
          timeoutMs: 180000,
          message:
            `First call memory with action "write", text "${memoryDeleteText}", type "semantic", sensitivity "personal". `
            + 'Use the returned memory id. Then call memory with action "delete" on that same id, '
            + 'justification_category "factually_incorrect", and explanation '
            + '"This disposable shakedown memory is factually incorrect test data." '
            + 'Do not attempt restore yet. Return only a JSON object with keys memoryId and proposalId.',
        });
        if (proposalTurn?.response?.ok !== true) {
          throw new Error('memory_delete_restore proposal turn did not complete successfully');
        }
        const proposalRows = await pgAll(
          `select p.id, p.memory_id, p.status from memory_deletion_proposals p join l2_memories m on m.id = p.memory_id where m.text like '%${memoryDeleteText}%' order by p.proposed_at desc limit 1;`,
        );
        const proposal = proposalRows?.[0];
        if (typeof proposal?.id !== 'string' || typeof proposal?.memory_id !== 'string') {
          throw new Error('memory_delete_restore did not persist its deletion proposal');
        }
        const confirmations = await fetchJson(`${adminBase}/api/admin/confirmations`, { signal });
        const approval = confirmations?.body?.entries?.find((entry) => (
          entry?.method === 'memory.deletion.validate'
          && entry?.params?.proposalId === proposal.id
        ));
        if (!approval?.id) {
          throw new Error('memory_delete_restore proposal did not reach the Operator confirmation surface');
        }
        const approved = await approveOperatorConfirmation(approval.id, signal);
        if (approved.ok !== true || approved.body?.status !== 'approved') {
          throw new Error('memory_delete_restore Operator approval did not execute successfully');
        }
        const approvedRows = await pgAll(
          `select id, memory_id, delete_id, status from memory_deletion_proposals where id = '${proposal.id}';`,
        );
        const approvedProposal = approvedRows?.[0];
        if (typeof approvedProposal?.delete_id !== 'string' || approvedProposal.status !== 'approved') {
          throw new Error('memory_delete_restore approval did not persist a delete checkpoint');
        }
        return chatCase({
          sessionId,
          apiUserId,
          signal,
          timeoutMs: 180000,
          message:
            `Call memory with action "restore" and delete_id "${approvedProposal.delete_id}". `
            + `Return only {"memoryId":"${proposal.memory_id}","deleteId":"${approvedProposal.delete_id}","deleted":true,"restored":true}. `
            + 'If the tool fails, report the exact error instead of claiming success.',
        });
      },
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
        const memoryRows = Array.isArray(sideChecks?.memoryRows) ? sideChecks.memoryRows : [];
        const activeMemoryIds = new Set(memoryRows
          .filter((row) => row?.deleted_at === null || row?.deletedAt === null)
          .map((row) => row?.id)
          .filter((id) => typeof id === 'string' && id.length > 0));
        const deleteRows = Array.isArray(sideChecks?.deleteRows) ? sideChecks.deleteRows : [];
        const restoredDeleteRows = deleteRows.filter((row) => row?.restored_at || row?.restoredAt);
        if (memoryRows.length === 0) {
          failures.push('memory_delete_restore must retain its restored memory row');
        } else if (activeMemoryIds.size === 0) {
          failures.push('memory_delete_restore must leave its restored memory active');
        }
        if (restoredDeleteRows.length === 0) {
          failures.push('memory_delete_restore must persist its own restored delete journal row');
        } else if (
          activeMemoryIds.size > 0
          && !restoredDeleteRows.some((row) => activeMemoryIds.has(row?.memory_id ?? row?.memoryId))
        ) {
          failures.push(
            'memory_delete_restore must correlate its restored journal with an active memory row',
          );
        }
        return failures;
      },
    }],
  };
}
