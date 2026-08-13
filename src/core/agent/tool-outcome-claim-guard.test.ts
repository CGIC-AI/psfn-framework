import type { AgentMessage } from '../../boundary/pi-agent/index.js';
import { describe, expect, it } from 'vitest';
import {
  rejectsUnconfirmedToolExecutionClaim,
  UNCONFIRMED_TOOL_EXECUTION_CORRECTION,
} from './tool-outcome-claim-guard.js';

function toolResult(outcome: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: `call-${outcome}`,
    toolName: 'fs',
    content: [{ type: 'text', text: `outcome=${outcome}` }],
    details: {},
    isError: outcome !== 'success',
    outcome,
    timestamp: 1,
  } as AgentMessage;
}

function namedToolResult(toolName: string, outcome: string): AgentMessage {
  return {
    ...toolResult(outcome),
    toolCallId: `call-${toolName}-${outcome}`,
    toolName,
  } as AgentMessage;
}

describe('tool outcome final-response conformance', () => {
  it.each(['policy_denial', 'validation_rejection', 'duplicate_skip', 'dependency_skip'])(
    'rejects execution-success claims for a %s-only operation',
    (outcome) => {
      expect(rejectsUnconfirmedToolExecutionClaim({
        responseText: 'Done. I successfully updated the file.',
        turnMessages: [toolResult(outcome)],
      })).toBe(true);
    },
  );

  it('allows an explicit non-success final response', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      responseText: 'I could not update the file because the call was denied.',
      turnMessages: [toolResult('policy_denial')],
    })).toBe(false);
  });

  it('allows a duplicate skip after a real success in the same turn', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      responseText: 'I updated the file successfully.',
      turnMessages: [toolResult('success'), toolResult('duplicate_skip')],
    })).toBe(false);
  });

  it('rejects a direct success claim when a skip accompanies an execution failure', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      responseText: 'Updated the file.',
      turnMessages: [toolResult('execution_failure'), toolResult('dependency_skip')],
    })).toBe(true);
  });

  it('rejects prose success when an explicitly requested active tool was never called', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      requestText: 'Call north_star to append this decision.',
      activeToolNames: ['north_star', 'memory'],
      responseText: 'Done. I successfully updated it.',
      turnMessages: [],
    })).toBe(true);
  });

  it('rejects structured success when an explicitly requested active tool was never called', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      requestText: 'Use selfie_create to make the requested image.',
      activeToolNames: ['selfie_create'],
      responseText: JSON.stringify({ created: true, attached: true }),
      turnMessages: [],
    })).toBe(true);
  });

  it('rejects a fabricated structured result even when it has no boolean success flag', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      requestText: 'Call beads to create and update the issue.',
      activeToolNames: ['beads'],
      responseText: JSON.stringify({ issueId: 'PSFN-fabricated', status: 'in_progress' }),
      turnMessages: [],
    })).toBe(true);
  });

  it('allows an honest structured tool failure', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      requestText: 'Call beads to create the issue.',
      activeToolNames: ['beads'],
      responseText: JSON.stringify({ error: 'The beads tool is unavailable and was not executed.' }),
      turnMessages: [],
    })).toBe(false);
  });

  it('requires every explicitly requested tool to have a successful result', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      requestText: 'Call self_status, then invoke notify exactly once.',
      activeToolNames: ['self_status', 'notify'],
      responseText: JSON.stringify({ inspected: true, notified: true }),
      turnMessages: [namedToolResult('self_status', 'success')],
    })).toBe(true);
  });

  it('allows success after every explicitly requested tool succeeds', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      requestText: 'Call self_status, then invoke notify exactly once.',
      activeToolNames: ['self_status', 'notify'],
      responseText: JSON.stringify({ inspected: true, notified: true }),
      turnMessages: [
        namedToolResult('self_status', 'success'),
        namedToolResult('notify', 'success'),
      ],
    })).toBe(false);
  });

  it('does not turn ordinary discussion of a tool into an execution requirement', () => {
    expect(rejectsUnconfirmedToolExecutionClaim({
      requestText: 'Why is north_star useful?',
      activeToolNames: ['north_star'],
      responseText: 'It is useful for durable direction setting.',
      turnMessages: [],
    })).toBe(false);
  });

  it('provides a non-fabricating runtime correction', () => {
    expect(UNCONFIRMED_TOOL_EXECUTION_CORRECTION).toContain('No matching successful tool execution');
  });
});
