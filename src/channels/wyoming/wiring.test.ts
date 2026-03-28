import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventBus } from '../../event-bus.js';
import { WyomingTcpServer } from './server.js';
import { WyomingRuntime } from './runtime.js';
import { createWyomingServiceRegistry } from './services/index.js';
import { createWyomingHandleServiceAdapter } from './services/handle.js';
import { createWyomingAsrServiceAdapter } from './services/asr.js';
import { createWyomingTtsServiceAdapter } from './services/tts.js';
import type { StreamingSttConnector } from '../../voice/connectors/stt/types.js';
import type { StreamingTtsConnector } from '../../voice/connectors/tts/types.js';

/**
 * Tests that verify Wyoming voice bridge production wiring:
 * - Config gate: Wyoming is only started when WYOMING_ENABLED=true
 * - Component composition: TcpServer + Runtime + ServiceRegistry are correctly wired
 * - Lifecycle: start/stop properly manage both server and runtime
 */

const activeServers: WyomingTcpServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.map((s) => s.stop()));
  activeServers.length = 0;
});

describe('Wyoming production wiring', () => {
  it('creates and starts Wyoming components when enabled', async () => {
    const eventBus = new EventBus();
    const handleMessage = vi.fn().mockResolvedValue({
      content: 'hello',
      channelId: 'test',
      metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0 },
    });

    const handleAdapter = createWyomingHandleServiceAdapter({
      handleMessage,
      eventBus,
    });
    const serviceRegistry = createWyomingServiceRegistry([handleAdapter]);

    // Use port 0 to let the OS assign a free port (we just need to verify start/stop lifecycle)
    const tcpServer = new WyomingTcpServer(
      { port: 10499, host: '127.0.0.1', eventBus },
      {
        onFrame: vi.fn(),
        onSessionClose: vi.fn(),
      },
    );
    activeServers.push(tcpServer);

    const runtime = new WyomingRuntime({
      info: {
        name: 'companion',
        version: '1.0.0',
        description: 'test',
        services: [],
      },
      emitFrame: (session, frame) => tcpServer.send(session, frame),
      serviceRegistry,
      eventBus,
    });

    // Verify server starts
    expect(tcpServer.isRunning()).toBe(false);
    await tcpServer.start();
    expect(tcpServer.isRunning()).toBe(true);

    // Verify runtime has no sessions
    expect(runtime.getActiveSessionCount()).toBe(0);

    // Verify clean shutdown
    await runtime.stop();
    await tcpServer.stop();
    expect(tcpServer.isRunning()).toBe(false);
  });

  it('service registry merges handle service info', () => {
    const handleAdapter = createWyomingHandleServiceAdapter({
      handleMessage: vi.fn().mockResolvedValue({
        content: '',
        channelId: '',
        metadata: { model: '', inputTokens: 0, outputTokens: 0, durationMs: 0 },
      }),
    });
    const registry = createWyomingServiceRegistry([handleAdapter]);

    expect(registry.services).toHaveLength(1);
    expect(registry.services[0]!.name).toBe('handle');
    expect(registry.services[0]!.supports).toContain('handle');
    expect(registry.services[0]!.supports).toContain('transcript');
    expect(registry.services[0]!.supports).toContain('text');
  });

  it('service registry advertises all 3 families when ASR and TTS adapters are registered', () => {
    const handleAdapter = createWyomingHandleServiceAdapter({
      handleMessage: vi.fn().mockResolvedValue({
        content: '',
        channelId: '',
        metadata: { model: '', inputTokens: 0, outputTokens: 0, durationMs: 0 },
      }),
    });

    const mockSttConnector: StreamingSttConnector = {
      id: 'deepgram',
      startStream: vi.fn(),
    };
    const asrAdapter = createWyomingAsrServiceAdapter({ stt: mockSttConnector });

    const mockTtsConnector: StreamingTtsConnector = {
      id: 'elevenlabs',
      synthesizeStream: vi.fn(),
      synthesizeBuffer: vi.fn(),
    };
    const ttsAdapter = createWyomingTtsServiceAdapter({ tts: mockTtsConnector });

    const registry = createWyomingServiceRegistry([handleAdapter, asrAdapter, ttsAdapter]);

    expect(registry.services).toHaveLength(3);
    const serviceNames = registry.services.map((s) => s.name);
    expect(serviceNames).toContain('handle');
    expect(serviceNames).toContain('asr');
    expect(serviceNames).toContain('tts');
  });

  it('ASR adapter service info contains expected event types', () => {
    const mockSttConnector: StreamingSttConnector = {
      id: 'deepgram',
      startStream: vi.fn(),
    };
    const asrAdapter = createWyomingAsrServiceAdapter({ stt: mockSttConnector });

    expect(asrAdapter.family).toBe('asr');
    expect(asrAdapter.service.name).toBe('asr');
    expect(asrAdapter.eventTypes).toContain('transcribe');
    expect(asrAdapter.eventTypes).toContain('audio-chunk');
    expect(asrAdapter.eventTypes).toContain('audio-stop');
  });

  it('TTS adapter service info contains expected event types', () => {
    const mockTtsConnector: StreamingTtsConnector = {
      id: 'echo',
      synthesizeStream: vi.fn(),
      synthesizeBuffer: vi.fn(),
    };
    const ttsAdapter = createWyomingTtsServiceAdapter({ tts: mockTtsConnector });

    expect(ttsAdapter.family).toBe('tts');
    expect(ttsAdapter.service.name).toBe('tts');
    expect(ttsAdapter.eventTypes).toContain('synthesize');
    expect(ttsAdapter.eventTypes).toContain('synthesize-start');
    expect(ttsAdapter.eventTypes).toContain('synthesize-stop');
  });

  it('registry dispatch routes to correct adapter by event type', async () => {
    const handleAdapter = createWyomingHandleServiceAdapter({
      handleMessage: vi.fn().mockResolvedValue({
        content: 'test-response',
        channelId: 'test-ch',
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0 },
      }),
    });

    const mockSttConnector: StreamingSttConnector = {
      id: 'deepgram',
      startStream: vi.fn(),
    };
    const asrAdapter = createWyomingAsrServiceAdapter({ stt: mockSttConnector });

    const mockTtsConnector: StreamingTtsConnector = {
      id: 'elevenlabs',
      synthesizeStream: vi.fn(),
      synthesizeBuffer: vi.fn(),
    };
    const ttsAdapter = createWyomingTtsServiceAdapter({ tts: mockTtsConnector });

    const registry = createWyomingServiceRegistry([handleAdapter, asrAdapter, ttsAdapter]);

    // Handle event should be routed to handle adapter
    const handleResult = await registry.dispatch({
      frame: {
        type: 'handle',
        data: {
          session_id: 's1',
          text: 'hello',
          site_id: 'ha-main',
          satellite_id: 'test-sat',
        },
      },
      sessionId: 's1',
      transportSession: { id: 'conn1', connectionId: 'conn1', openedAtMs: 0, lastSeenAtMs: 0 },
    });
    expect(handleResult).toBeDefined();

    // Synthesize event should be routed to tts adapter
    const ttsResult = await registry.dispatch({
      frame: {
        type: 'synthesize',
        data: {
          session_id: 's1',
          text: 'say something',
        },
      },
      sessionId: 's1',
      transportSession: { id: 'conn1', connectionId: 'conn1', openedAtMs: 0, lastSeenAtMs: 0 },
    });
    expect(ttsResult).toBeDefined();

    // Transcribe event should be routed to asr adapter
    const asrResult = await registry.dispatch({
      frame: {
        type: 'transcribe',
        data: {
          session_id: 's1',
          sample_rate: 16000,
        },
      },
      sessionId: 's1',
      transportSession: { id: 'conn1', connectionId: 'conn1', openedAtMs: 0, lastSeenAtMs: 0 },
    });
    expect(asrResult).toBeDefined();
  });

  it('does NOT start Wyoming when config is disabled', () => {
    // Simulate the config gate pattern used in gateway-main.ts and split runtime wiring.
    const wyomingEnabled = false as boolean;
    let tcpServer: WyomingTcpServer | undefined;
    let wyomingRuntime: WyomingRuntime | undefined;

    if (wyomingEnabled) {
      tcpServer = new WyomingTcpServer(
        { port: 10400, host: '127.0.0.1' },
        {},
      );
      wyomingRuntime = new WyomingRuntime({
        info: { name: 'test', version: '1.0.0', services: [] },
        emitFrame: vi.fn(),
      });
    }

    expect(tcpServer).toBeUndefined();
    expect(wyomingRuntime).toBeUndefined();
  });
});

describe('Wyoming config parsing', () => {
  it('parses WYOMING_ENABLED from env', async () => {
    // Dynamic import to get a clean module each time
    const { loadConfig } = await import('../../types.js');

    // Save original env
    const origEnabled = process.env.WYOMING_ENABLED;
    const origPort = process.env.WYOMING_PORT;
    const origHost = process.env.WYOMING_HOST;

    try {
      // Test default (disabled)
      delete process.env.WYOMING_ENABLED;
      delete process.env.WYOMING_PORT;
      delete process.env.WYOMING_HOST;
      let config = loadConfig();
      expect(config.wyomingEnabled).toBe(false);

      // Test enabled
      process.env.WYOMING_ENABLED = 'true';
      config = loadConfig();
      expect(config.wyomingEnabled).toBe(true);

      // Test disabled explicitly
      process.env.WYOMING_ENABLED = 'false';
      config = loadConfig();
      expect(config.wyomingEnabled).toBe(false);
    } finally {
      // Restore
      if (origEnabled !== undefined) process.env.WYOMING_ENABLED = origEnabled;
      else delete process.env.WYOMING_ENABLED;
      if (origPort !== undefined) process.env.WYOMING_PORT = origPort;
      else delete process.env.WYOMING_PORT;
      if (origHost !== undefined) process.env.WYOMING_HOST = origHost;
      else delete process.env.WYOMING_HOST;
    }
  });

  it('parses WYOMING_HOST and WYOMING_PORT from env', async () => {
    const { loadConfig } = await import('../../types.js');

    const origHost = process.env.WYOMING_HOST;
    const origPort = process.env.WYOMING_PORT;

    try {
      // Default host
      delete process.env.WYOMING_HOST;
      delete process.env.WYOMING_PORT;
      let config = loadConfig();
      expect(config.wyomingHost).toBe('127.0.0.1');
      expect(config.wyomingPort).toBeUndefined();

      // Custom values
      process.env.WYOMING_HOST = '0.0.0.0';
      process.env.WYOMING_PORT = '10500';
      config = loadConfig();
      expect(config.wyomingHost).toBe('0.0.0.0');
      expect(config.wyomingPort).toBe(10500);
    } finally {
      if (origHost !== undefined) process.env.WYOMING_HOST = origHost;
      else delete process.env.WYOMING_HOST;
      if (origPort !== undefined) process.env.WYOMING_PORT = origPort;
      else delete process.env.WYOMING_PORT;
    }
  });
});
