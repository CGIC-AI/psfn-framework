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

  it('provides a non-fabricating runtime correction', () => {
    expect(UNCONFIRMED_TOOL_EXECUTION_CORRECTION).toContain('no successful execution occurred');
  });
});
