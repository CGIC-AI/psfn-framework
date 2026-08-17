import { JSONRPCErrorCode } from 'json-rpc-2.0';
import { describe, expect, it } from 'vitest';

import {
  agentMethodParamDecoders,
  gatewayMethodParamDecoders,
} from './params.js';

type UnknownDecoder = (params: unknown) => unknown;

const expectedGatewayMethods = [
  'llm.chat',
  'llm.complete',
  'llm.embed',
  'llm.cancel',
  'llm.discover_models',
  'llm.invalidate_model_discovery',
  'discord.send',
  'discord.sendMedia',
  'discord.typing',
  'confirmation.list',
  'confirmation.history',
  'confirmation.resolve',
  'notify.ntfy',
  'notify.operator',
  'clarify.deliver',
  'runtime.health',
  'runtime.credential_presence',
  'web.fetch',
  'web.fetch_binary',
  'web.request_binary',
  'web.search',
  'shell.exec',
  'shard.backend.request',
  'vault.write',
  'vault.read',
  'vault.search',
  'vault.daily',
  'fs.read',
  'fs.write',
  'fs.list',
  'fs.search',
  'fs.edit',
  'git.status',
  'git.diff',
  'git.create_branch',
  'git.apply_patch',
  'git.commit',
  'git.open_pr',
  'beads.ready',
  'beads.show',
  'beads.create',
  'beads.update',
  'beads.close',
  'beads.sync',
  'image.create',
  'image.edit',
  'home_assistant.get_states',
  'home_assistant.call_service',
  'home_assistant.check_connection',
  'session.hmac.sign',
  'session.hmac.verify',
  'kube.self_management',
] as const;

const expectedAgentMethods = [
  'memory.deletion.snapshot',
  'memory.deletion.partner_alerted',
  'memory.deletion.resolve',
  'contact.authority.snapshot',
  'voice.handleMessage',
  'voice.stream.start',
  'voice.stream.chunk',
  'voice.stream.end',
  'voice.stream.cancel',
  'api.chat.completion',
  'api.chat.cancel',
  'api.companion-ui.shard.action',
  'shard.directory.owner',
  'api.telemetry.ingest',
  'api.health',
  'satellite.response.eligibility',
  'telemetry.turn.performance',
] as const;

function expectInvalid(decoder: UnknownDecoder, params: unknown): void {
  expect(() => decoder(params)).toThrow(expect.objectContaining({
    code: JSONRPCErrorCode.InvalidParams,
  }));
}

describe('gateway RPC parameter decoder catalog', () => {
  it('keeps the reviewed 52 gateway plus 17 reverse-agent decoder inventory exact', () => {
    expect(Object.keys(gatewayMethodParamDecoders)).toEqual(expectedGatewayMethods);
    expect(Object.keys(agentMethodParamDecoders)).toEqual(expectedAgentMethods);
    expect(expectedGatewayMethods).toHaveLength(52);
    expect(expectedAgentMethods).toHaveLength(17);
  });

  it('rejects non-object params across the complete catalog', () => {
    for (const decoder of Object.values(gatewayMethodParamDecoders)) {
      expectInvalid(decoder, null);
    }
    for (const decoder of Object.values(agentMethodParamDecoders)) {
      expectInvalid(decoder, null);
    }
  });

  it('rejects malformed fields and unexpected top-level properties', () => {
    expectInvalid(gatewayMethodParamDecoders['fs.read'], { path: 42 });
    expectInvalid(gatewayMethodParamDecoders['fs.read'], {
      path: 'notes/today.md',
      unrecognizedAuthority: true,
    });
    expectInvalid(gatewayMethodParamDecoders['llm.chat'], {
      model: 'test-model',
      provider: 'test-provider',
      messages: [{ role: 'user', content: 42 }],
      systemPrompt: '',
    });
    expectInvalid(gatewayMethodParamDecoders['llm.chat'], {
      model: 'test-model',
      provider: 'test-provider',
      messages: [{
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }],
      systemPrompt: '',
    });
    expectInvalid(gatewayMethodParamDecoders['notify.ntfy'], {
      message: 'hello',
      sender: { kind: 'operator', provenance: 'test' },
    });
    expectInvalid(agentMethodParamDecoders['voice.stream.chunk'], {
      correlationId: 'correlation-1',
      streamId: 'stream-1',
      sequence: 1,
      text: 42,
    });
    expectInvalid(agentMethodParamDecoders['api.health'], {
      unrecognizedAuthority: true,
    });
    expectInvalid(gatewayMethodParamDecoders['shard.backend.request'], {
      backend: 'container',
      shardId: 'shard-1',
      name: 'worker',
      ownerVersion: 'a'.repeat(64),
      grantDigest: 'b'.repeat(64),
      capabilityTier: 'autonomous',
      customTokens: ['shard.spawn'],
    });
  });

  it('returns valid params by identity', () => {
    const fsParams = { path: 'notes/today.md', maxBytes: 1024 };
    const llmParams = {
      model: 'test-model',
      provider: 'test-provider',
      messages: [{ role: 'user' as const, content: 'hello' }],
      systemPrompt: '',
      purpose: 'chat' as const,
    };
    const voiceParams = {
      correlationId: 'correlation-1',
      streamId: 'stream-1',
      sequence: 1,
      text: 'hello',
    };

    expect(gatewayMethodParamDecoders['fs.read'](fsParams)).toBe(fsParams);
    expect(gatewayMethodParamDecoders['llm.complete'](llmParams)).toBe(llmParams);
    expect(agentMethodParamDecoders['voice.stream.chunk'](voiceParams)).toBe(voiceParams);
  });

  it('accepts every exact GatewayLLMContentBlock variant', () => {
    const contentBlocks = [
      { type: 'text', text: 'hello', textSignature: 'text-signature' },
      { type: 'image', data: 'base64-data', mimeType: 'image/png' },
      {
        type: 'thinking',
        thinking: 'private reasoning',
        thinkingSignature: 'thinking-signature',
        redacted: true,
      },
      {
        type: 'toolCall',
        id: 'tool-call-1',
        name: 'search',
        arguments: { query: 'hello' },
        thoughtSignature: 'thought-signature',
      },
      { type: 'gateway_image_ref', handle: 'retained-image-1' },
    ];

    for (const block of contentBlocks) {
      const params = {
        messages: [{ role: 'assistant', content: [block] }],
        systemPrompt: 'system',
        purpose: 'background' as const,
      };
      expect(gatewayMethodParamDecoders['llm.complete'](params)).toBe(params);
    }
  });

  it('rejects malformed, unknown, and extended GatewayLLMContentBlock variants', () => {
    const invalidContentBlocks = [
      { type: 'text', text: 42 },
      { type: 'text', text: 'hello', unexpected: true },
      { type: 'image', data: 42, mimeType: false },
      { type: 'thinking', redacted: true },
      { type: 'toolCall', id: 'tool-call-1', name: 'search', arguments: [] },
      { type: 'gateway_image_ref' },
      { type: 'audio', data: 'base64-data' },
    ];

    for (const block of invalidContentBlocks) {
      expectInvalid(gatewayMethodParamDecoders['llm.complete'], {
        messages: [{ role: 'assistant', content: [block] }],
        systemPrompt: 'system',
        purpose: 'background',
      });
    }
  });

  it('admits only canonical cancellation identifiers', () => {
    const validParams = {
      cancellationId: '44444444-4444-4444-8444-444444444444',
      texts: ['hello'],
    };

    expect(gatewayMethodParamDecoders['llm.embed'](validParams)).toBe(validParams);
    expectInvalid(gatewayMethodParamDecoders['llm.embed'], {
      cancellationId: 'not-a-canonical-uuid',
      texts: ['hello'],
    });
  });

  it('admits complete embedding provenance and rejects partial or invented lanes', () => {
    const usageProvenance = {
      callType: 'background',
      purpose: 'automata_bus.indexing',
      originType: 'background',
      originStage: 'automata_bus.indexing',
      service: 'automata_bus',
      process: 'finding-index',
      runtimeLaneClass: 'background_continuation',
      workloadType: 'automata_bus_indexing',
      workloadId: 'finding-7',
    };
    const valid = { texts: ['hello'], usageProvenance };

    expect(gatewayMethodParamDecoders['llm.embed'](valid)).toBe(valid);
    expectInvalid(gatewayMethodParamDecoders['llm.embed'], {
      texts: ['hello'],
      usageProvenance: { ...usageProvenance, runtimeLaneClass: 'invented_lane' },
    });
    const { workloadId: _missing, ...partial } = usageProvenance;
    expectInvalid(gatewayMethodParamDecoders['llm.embed'], {
      texts: ['hello'],
      usageProvenance: partial,
    });
  });
});
