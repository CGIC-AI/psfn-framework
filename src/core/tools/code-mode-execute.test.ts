import { Type } from '@sinclair/typebox';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '../../boundary/pi-agent/index.js';
import { getRequestContext, runWithRequestContext } from '../../primitives/llm/request-context.js';
import { withViewerReadGate } from '../agent/tool-surface/viewer-read-gate.js';
import {
  createCodeModeExecuteTool,
  HYBRID_CODE_MODE_DIRECT_WIRE_TOOLS,
  isCodeModeSdkCallableTool,
} from './code-mode-execute.js';

function makeJsonTool(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
  parameters = Type.Object({
    action: Type.Union([Type.Literal('read'), Type.Literal('write')]),
    query: Type.Optional(Type.String()),
  }),
): AgentTool<any> {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters,
    execute: async (_id, params) => {
      const value = await handler(params as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
        details: {},
      };
    },
  };
}

describe('createCodeModeExecuteTool (Hybrid Code Mode REPL)', () => {
  it('classifies direct wire egress and meta tools as non-SDK-callable', () => {
    for (const directWire of ['notify', 'mcp', 'publication', 'response_control']) {
      expect(isCodeModeSdkCallableTool(directWire)).toBe(false);
      expect(HYBRID_CODE_MODE_DIRECT_WIRE_TOOLS.has(directWire)).toBe(true);
    }
    expect(isCodeModeSdkCallableTool('execute')).toBe(false);
    expect(isCodeModeSdkCallableTool('tool_search')).toBe(false);
    expect(isCodeModeSdkCallableTool('toolset')).toBe(false);
    expect(isCodeModeSdkCallableTool('memory')).toBe(true);
    expect(isCodeModeSdkCallableTool('file_editor')).toBe(true);
    expect(isCodeModeSdkCallableTool('shell')).toBe(true);
  });

  it('executes multi-step async JS over gated canonical tools in an isolated child VM while excluding direct egress tools', async () => {
    const memory = makeJsonTool('memory', async (args) => ({
      items: [{ id: 'm1', query: args.query }],
    }), Type.Object({
      action: Type.Literal('search'),
      query: Type.String(),
    }));
    const journal = makeJsonTool('journal', async (args) => ({
      written: true,
      note: args.query,
    }));
    const notify = makeJsonTool('notify', async () => ({ sent: true }));
    const mcp = makeJsonTool('mcp', async () => ({ called: true }));
    const publication = makeJsonTool('publication', async () => ({ published: true }));
    const responseControl = makeJsonTool('response_control', async () => ({ noReply: true }));
    const onToolResultAdmitted = vi.fn();

    const executeTool = createCodeModeExecuteTool({
      getCallableTools: () => [memory, journal, notify, mcp, publication, responseControl],
      onToolResultAdmitted,
    });

    const result = await executeTool.execute('exec-1', {
      code: `
        const found = await sdk.memory({ action: 'search', query: 'Paris' });
        const saved = await sdk.journal({ action: 'write', query: found.items[0].id });
        return {
          found,
          saved,
          sdkFrozen: Object.isFrozen(sdk),
          egressHidden: {
            notify: typeof sdk.notify,
            mcp: typeof sdk.mcp,
            publication: typeof sdk.publication,
            response_control: typeof sdk.response_control,
            execute: typeof sdk.execute,
          },
          sandboxGlobals: {
            process: typeof process,
            fetch: typeof fetch,
            require: typeof require,
          },
        };
      `,
    });

    expect(result.details?.isError).toBeUndefined();
    const textBlock = result.content[0];
    expect(textBlock?.type).toBe('text');
    const parsed = JSON.parse(textBlock?.type === 'text' ? textBlock.text : '{}');
    expect(parsed).toEqual({
      found: { items: [{ id: 'm1', query: 'Paris' }] },
      saved: { written: true, note: 'm1' },
      sdkFrozen: true,
      egressHidden: {
        notify: 'undefined',
        mcp: 'undefined',
        publication: 'undefined',
        response_control: 'undefined',
        execute: 'undefined',
      },
      sandboxGlobals: {
        process: 'undefined',
        fetch: 'undefined',
        require: 'undefined',
      },
    });
    expect(result.details?.innerCalls).toEqual([
      { tool: 'memory', ok: true },
      { tool: 'journal', ok: true },
    ]);
    expect(onToolResultAdmitted).toHaveBeenCalledTimes(2);
    expect(onToolResultAdmitted).toHaveBeenNthCalledWith(1, {
      toolName: 'memory',
      arguments: { action: 'search', query: 'Paris' },
    });
    expect(onToolResultAdmitted).toHaveBeenNthCalledWith(2, {
      toolName: 'journal',
      arguments: { action: 'write', query: 'm1' },
    });
  });

  it('preserves AsyncLocalStorage request context and enforces viewer read gates inside inner sdk calls', async () => {
    const fileEditor = withViewerReadGate(makeJsonTool('file_editor', async () => {
      const ctx = getRequestContext();
      return {
        body: 'personal workspace note',
        channelId: ctx?.channelId ?? null,
        viewerTrustLevel: ctx?.viewerTrustLevel ?? null,
        viewerChannelPrivacy: ctx?.viewerChannelPrivacy ?? null,
      };
    }));

    const executeTool = createCodeModeExecuteTool({
      getCallableTools: () => [fileEditor],
    });

    const publicResult = await runWithRequestContext({
      channelId: 'discord:public-lobby',
      turnId: 'turn-public',
      requestId: 'req-public',
      viewerTrustLevel: 'stranger',
      viewerChannelPrivacy: 'public',
    }, async () => executeTool.execute('exec-public', {
      code: `return await sdk.file_editor({ action: 'read' });`,
    }));

    const publicText = publicResult.content[0]?.type === 'text' ? publicResult.content[0].text : '';
    expect(publicText).toContain('withheld by visibility gating');
    expect(publicText).not.toContain('personal workspace note');

    const privateResult = await runWithRequestContext({
      channelId: 'discord:dm-primary',
      turnId: 'turn-private',
      requestId: 'req-private',
      viewerTrustLevel: 'primary',
      viewerChannelPrivacy: 'private',
    }, async () => executeTool.execute('exec-private', {
      code: `return await sdk.file_editor({ action: 'read' });`,
    }));

    const privateText = privateResult.content[0]?.type === 'text' ? privateResult.content[0].text : '';
    expect(JSON.parse(privateText)).toEqual({
      body: 'personal workspace note',
      channelId: 'discord:dm-primary',
      viewerTrustLevel: 'primary',
      viewerChannelPrivacy: 'private',
    });
  });

  it('screens every inner tool result via CogSec and fails closed when quarantined or when the screener throws', async () => {
    const webTool = makeJsonTool('web', async (args) => {
      if (args.query === 'poison') return 'HOSTILE_INJECTION_SECRET_BYTES';
      if (args.query === 'crash') return 'UNSCREENED_SENSITIVE_DATA';
      return { safe: true };
    });
    const onTelemetry = vi.fn();
    const executeTool = createCodeModeExecuteTool({
      getCallableTools: () => [webTool],
      onTelemetry,
      toolResultScreener: ({ text }) => {
        if (text.includes('UNSCREENED_SENSITIVE_DATA')) {
          throw new Error('screener crash quoting UNSCREENED_SENSITIVE_DATA');
        }
        if (text.includes('HOSTILE_INJECTION_SECRET_BYTES')) {
          return {
            mode: 'enforce',
            withheld: true,
            effectiveText: '[System notice] Content withheld by cognitive security.',
            snapshot: {
              envelopeId: 'env-1',
              sourceClass: 'tool_output',
              sourceRiskTier: 'untrusted',
              state: 'quarantined',
              riskLabels: ['injection/override_attempt'],
              enforcementPosture: 'enforce',
              subject: { kind: 'body' },
            },
          };
        }
        return {
          mode: 'enforce',
          withheld: false,
          effectiveText: text,
          snapshot: {
            envelopeId: 'env-2',
            sourceClass: 'tool_output',
            sourceRiskTier: 'trusted',
            state: 'admitted',
            riskLabels: [],
            enforcementPosture: 'enforce',
            subject: { kind: 'body' },
          },
        };
      },
    });

    const result = await executeTool.execute('exec-screen', {
      code: `
        const poisoned = await sdk.web({ action: 'read', query: 'poison' });
        const crashed = await sdk.web({ action: 'read', query: 'crash' });
        const ok = await sdk.web({ action: 'read', query: 'safe' });
        return { poisoned, crashed, ok };
      `,
    });

    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).not.toContain('HOSTILE_INJECTION_SECRET_BYTES');
    expect(text).not.toContain('UNSCREENED_SENSITIVE_DATA');
    expect(text).not.toContain('screener crash');
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      poisoned: {
        isError: true,
        withheld: true,
        text: '[System notice] Content withheld by cognitive security.',
      },
      crashed: {
        isError: true,
        withheld: true,
        text: 'Internal tool status: the web result was withheld because intake screening failed.',
      },
      ok: { safe: true },
    });
    expect(result.details?.withheldCount).toBe(2);
    expect(onTelemetry).toHaveBeenCalledWith('agent.tools.intake.screened', expect.objectContaining({
      toolName: 'web',
      withheld: true,
      viaCodeModeExecute: true,
    }));
    expect(onTelemetry).toHaveBeenCalledWith('agent.tools.intake.screen_failed', expect.objectContaining({
      toolName: 'web',
      viaCodeModeExecute: true,
    }));
  });

  it('validates inner tool arguments against their JSON schema before invoking the handler', async () => {
    const spy = vi.fn(async () => ({ ok: true }));
    const memory = makeJsonTool('memory', spy, Type.Object({
      action: Type.Literal('search'),
      query: Type.String(),
    }));
    const executeTool = createCodeModeExecuteTool({
      getCallableTools: () => [memory],
    });

    const result = await executeTool.execute('exec-invalid', {
      code: `return await sdk.memory({ action: 'search' });`,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.details?.isError).toBe(true);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Invalid arguments for sdk.memory');
  });
});
