// ── Voice Round-Trip E2E Harness ──
// Closed-loop validation:
// 1) Seed text -> ElevenLabs TTS audio
// 2) Seed audio -> Deepgram STT (baseline provider check)
// 3) Seed audio -> PSFN websocket voice runtime (STT -> agent -> TTS)
// 4) Runtime TTS audio -> Deepgram STT
// 5) Compare text sent to TTS vs text recovered from audio
//
// Run: npx tsx src/e2e-voice-roundtrip.ts

import 'dotenv/config';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './types.js';
import type { SubstrateMessage } from './types.js';
import { EventBus } from './event-bus.js';
import { LLMClient } from './llm/client.js';
import { composeAgentLoop, composeIdentity, composeSessionRuntime } from './bootstrap/composition.js';
import { ElevenLabsTtsClient } from './voice/elevenlabs.js';
import { DeepgramSttClient } from './voice/deepgram.js';
import { createApiVoiceWebSocketRuntime } from './channels/api/voice-websocket-runtime.js';
import { serializeVoiceWireFrame } from './voice/transports/websocket/serializer.js';
import {
  VOICE_WIRE_PROTOCOL,
  type VoiceWireFrame,
  type VoiceWireInboundFrame,
  type WebSocketVoiceConnection,
} from './voice/transports/websocket/types.js';
import type {
  VoiceWebSocketRuntime,
  VoiceWebSocketRuntimeContext,
} from './channels/api/voice-websocket.js';

const execFileAsync = promisify(execFile);

const SIGN_PHRASE = process.env.VOICE_E2E_SIGN ?? 'sunset orchard';
const COUNTERSIGN_PHRASE = process.env.VOICE_E2E_COUNTERSIGN ?? 'amber lantern';

const DEFAULT_INPUT_PHRASE = [
  'PSFN, this is a voice verification challenge.',
  `Reply in one short sentence that starts with "Countersign ${SIGN_PHRASE}."`,
  `Also include the phrase "${COUNTERSIGN_PHRASE}".`,
  'Do not use markdown.',
].join(' ');
const INPUT_PHRASE = process.env.VOICE_E2E_PROMPT ?? DEFAULT_INPUT_PHRASE;

const INPUT_PCM_CHUNK_BYTES = 4096;
const WAIT_TIMEOUT_MS = 180_000;

class InMemoryVoiceConnection implements WebSocketVoiceConnection {
  readonly id: string;
  readonly outboundRaw: string[] = [];
  readonly outboundFrames: VoiceWireFrame[] = [];

  private readonly messageHandlers = new Set<(data: string) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(id: string) {
    this.id = id;
  }

  send(data: string): void {
    if (this.closed) return;

    this.outboundRaw.push(data);
    try {
      this.outboundFrames.push(JSON.parse(data) as VoiceWireFrame);
    } catch {
      // Keep raw payload even if parse fails.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closeHandlers]) {
      handler();
    }
    this.closeHandlers.clear();
    this.messageHandlers.clear();
  }

  onMessage(handler: (data: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emitInbound(frame: VoiceWireInboundFrame): void {
    this.emitInboundRaw(serializeVoiceWireFrame(frame));
  }

  emitInboundRaw(raw: string): void {
    if (this.closed) return;
    for (const handler of [...this.messageHandlers]) {
      handler(raw);
    }
  }
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordOverlapScore(a: string, b: string): number {
  const setA = new Set(normalizeText(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeText(b).split(' ').filter(Boolean));

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }

  return intersection / Math.max(setA.size, setB.size);
}

function textsMatch(expected: string, actual: string): { pass: boolean; score: number; reason: string } {
  const normExpected = normalizeText(expected);
  const normActual = normalizeText(actual);

  if (!normExpected || !normActual) {
    return { pass: false, score: 0, reason: 'one side is empty' };
  }

  if (normExpected === normActual) {
    return { pass: true, score: 1, reason: 'exact normalized match' };
  }

  if (normActual.includes(normExpected) || normExpected.includes(normActual)) {
    return { pass: true, score: 0.95, reason: 'substring normalized match' };
  }

  const score = wordOverlapScore(normExpected, normActual);
  if (score >= 0.72) {
    return { pass: true, score, reason: 'word-overlap threshold met' };
  }

  return { pass: false, score, reason: 'word-overlap below threshold' };
}

function includesNormalizedPhrase(text: string, phrase: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedText || !normalizedPhrase) return false;
  return normalizedText.includes(normalizedPhrase);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function transcodeWithFfmpeg(
  input: Buffer,
  inputExt: string,
  outputExt: string,
  args: string[],
): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-voice-roundtrip-'));
  const inPath = join(dir, `in.${inputExt}`);
  const outPath = join(dir, `out.${outputExt}`);

  try {
    writeFileSync(inPath, input);
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inPath,
      ...args,
      outPath,
    ]);
    return readFileSync(outPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function chunkBuffer(source: Buffer, chunkBytes: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < source.length; offset += chunkBytes) {
    chunks.push(source.subarray(offset, Math.min(offset + chunkBytes, source.length)));
  }
  return chunks;
}

function assertConfigured(name: string, value: string | undefined): void {
  if (!value || !value.trim()) {
    throw new Error(`Missing required configuration: ${name}`);
  }
}

function buildVoiceMessage(channelId: string, content: string): SubstrateMessage {
  return {
    id: `voice-e2e-${randomUUID()}`,
    channelId,
    channelType: 'api',
    authorId: 'voice-e2e-user',
    authorName: 'Voice E2E User',
    content,
    isDirectMessage: true,
    timestamp: new Date(),
  };
}

function collectPlaybackAudio(frames: VoiceWireFrame[]): Buffer {
  const playback = frames
    .filter((frame): frame is Extract<VoiceWireFrame, { type: 'playback.chunk' }> => frame.type === 'playback.chunk')
    .sort((a, b) => a.seq - b.seq);

  if (playback.length === 0) return Buffer.alloc(0);

  const buffers = playback.map((chunk) => Buffer.from(chunk.audioBase64, 'base64'));
  return Buffer.concat(buffers);
}

function latestTranscriptFinal(frames: VoiceWireFrame[]): string {
  const finals = frames
    .filter((frame): frame is Extract<VoiceWireFrame, { type: 'transcript.final' }> => frame.type === 'transcript.final')
    .map((frame) => (frame as { text: string }).text.trim())
    .filter(Boolean);

  return finals[finals.length - 1] ?? '';
}

async function runSystemVoiceTurn(params: {
  runtime: VoiceWebSocketRuntime;
  inputPcm48k: Buffer;
}): Promise<{
  frames: VoiceWireFrame[];
  transcriptFromRuntime: string;
  playbackAudio: Buffer;
}> {
  const { runtime, inputPcm48k } = params;
  const connection = new InMemoryVoiceConnection(`voice-e2e-conn-${Date.now()}`);
  const request = {
    headers: {
      'x-user-id': 'voice-e2e-user',
      'x-user-name': 'Voice E2E User',
      'x-session-id': `voice-e2e-${Date.now()}`,
    },
  } as unknown as IncomingMessage;

  const context: VoiceWebSocketRuntimeContext = { request };
  const detach = runtime.attach(connection, context);
  const sessionId = `voice-session-${Date.now()}`;

  try {
    connection.emitInbound({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId,
    });

    await waitFor(() => connection.outboundFrames.some(
      (frame) => frame.type === 'ack' && frame.ackType === 'session.start' && frame.sessionId === sessionId,
    ));

    const inputChunks = chunkBuffer(inputPcm48k, INPUT_PCM_CHUNK_BYTES);
    let seq = 0;
    for (const chunk of inputChunks) {
      seq += 1;
      connection.emitInbound({
        wire: VOICE_WIRE_PROTOCOL,
        type: 'audio.chunk',
        sessionId,
        seq,
        audioBase64: chunk.toString('base64'),
      });
    }

    connection.emitInbound({
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.end',
      sessionId,
    });

    await waitFor(() => {
      const hasEndAck = connection.outboundFrames.some(
        (frame) => frame.type === 'ack' && frame.ackType === 'session.end' && frame.sessionId === sessionId,
      );
      const hasError = connection.outboundFrames.some(
        (frame) => frame.type === 'error' && frame.sessionId === sessionId,
      );
      return hasEndAck || hasError;
    });

    const frames = [...connection.outboundFrames].filter((frame) => frame.sessionId === sessionId);
    const terminalError = frames.find(
      (frame): frame is Extract<VoiceWireFrame, { type: 'error' }> => frame.type === 'error',
    );
    if (terminalError) {
      throw new Error(`Voice runtime returned error frame: ${terminalError.code} ${terminalError.message}`);
    }

    const transcriptFromRuntime = latestTranscriptFinal(frames);
    const playbackAudio = collectPlaybackAudio(frames);

    return { frames, transcriptFromRuntime, playbackAudio };
  } finally {
    detach();
    connection.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  assertConfigured('DEEPGRAM_API_KEY', config.deepgramApiKey);
  assertConfigured('ELEVENLABS_API_KEY', config.elevenLabsApiKey);
  assertConfigured('ELEVENLABS_VOICE_ID', config.elevenLabsVoiceId);
  assertConfigured('OPENROUTER_API_KEY', process.env.OPENROUTER_API_KEY);

  console.log('=== Voice Round-Trip E2E ===');
  console.log(`Primary model: ${config.primaryModel}`);

  // Provider clients used for baseline and final audio verification
  const ttsClient = new ElevenLabsTtsClient({
    apiKey: config.elevenLabsApiKey!,
    voiceId: config.elevenLabsVoiceId!,
    modelId: config.elevenLabsModelId,
  });

  const sttClient = new DeepgramSttClient({
    apiKey: config.deepgramApiKey!,
    model: config.deepgramModel,
  });

  // Step 1: seed text -> elevenlabs audio
  console.log('\n[1/6] Synthesizing seed phrase with ElevenLabs...');
  const seedMp3 = await ttsClient.synthesize(INPUT_PHRASE);
  console.log(`  Seed MP3 bytes: ${seedMp3.length}`);

  // Step 2: elevenlabs audio -> deepgram stt baseline
  console.log('[2/6] Baseline STT of seed audio with Deepgram...');
  const seedWav16k = await transcodeWithFfmpeg(seedMp3, 'mp3', 'wav', [
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
  ]);
  const seedBaselineTranscript = await sttClient.transcribeWav(seedWav16k);
  const baselineMatch = textsMatch(INPUT_PHRASE, seedBaselineTranscript);
  console.log(`  Baseline transcript: ${seedBaselineTranscript}`);
  console.log(`  Baseline match: ${baselineMatch.pass} (${baselineMatch.score.toFixed(2)} | ${baselineMatch.reason})`);

  // Build agent + voice runtime using real system components
  const eventBus = new EventBus();
  const llmClient = new LLMClient(config);
  const { systemPrompt } = composeIdentity(config);
  const { sessionManager } = composeSessionRuntime({ config });
  const agentLoop = composeAgentLoop({
    eventBus,
    llmProvider: llmClient,
    sessionManager,
    systemPrompt,
    config,
  });

  await eventBus.emit('system.init', {});
  await eventBus.emit('system.ready', {});

  let textSentToTts = '';
  eventBus.on('voice.tts.requested', ({ text }) => {
    if (text && text.trim()) {
      textSentToTts = text.trim();
    }
  });

  const runtime = createApiVoiceWebSocketRuntime({
    agentLoop,
    eventBus,
    config,
  });

  if (!runtime) {
    throw new Error('Voice websocket runtime did not initialize (missing config).');
  }

  try {
    // Prepare runtime input: mp3 -> PCM s16le 48k mono (runtime STT config)
    console.log('[3/6] Preparing runtime input audio (mp3 -> pcm_s16le 48k)...');
    const inputPcm48k = await transcodeWithFfmpeg(seedMp3, 'mp3', 's16le', [
      '-ac', '1',
      '-ar', '48000',
      '-f', 's16le',
    ]);
    console.log(`  Input PCM bytes: ${inputPcm48k.length}`);

    // Step 4: run through system voice pipeline
    console.log('[4/6] Running audio through PSFN websocket voice runtime...');
    const { frames, transcriptFromRuntime, playbackAudio } = await runSystemVoiceTurn({
      runtime,
      inputPcm48k,
    });

    console.log(`  Runtime transcript.final: ${transcriptFromRuntime || '(empty)'}`);
    console.log(`  Runtime playback audio bytes: ${playbackAudio.length}`);
    console.log(`  Runtime text sent to TTS: ${textSentToTts || '(empty)'}`);

    if (!playbackAudio.length) {
      throw new Error('No playback audio returned from runtime');
    }
    if (!textSentToTts) {
      throw new Error('Did not capture voice.tts.requested text from runtime');
    }

    // Step 5: runtime reply audio -> deepgram stt
    console.log('[5/6] Transcribing runtime response audio with Deepgram...');
    const responseWav16k = await transcodeWithFfmpeg(playbackAudio, 'mp3', 'wav', [
      '-ac', '1',
      '-ar', '16000',
      '-f', 'wav',
    ]);
    const responseTranscript = await sttClient.transcribeWav(responseWav16k);
    console.log(`  Response transcript: ${responseTranscript}`);

    // Step 6: comparisons
    console.log('[6/6] Comparing expected text and recovered response text...');
    const inputRuntimeMatch = textsMatch(INPUT_PHRASE, transcriptFromRuntime || seedBaselineTranscript);
    const outputMatch = textsMatch(textSentToTts, responseTranscript);
    const expectedSignals = {
      signPhrase: SIGN_PHRASE,
      countersignPhrase: COUNTERSIGN_PHRASE,
    };

    const semanticSignalInTtsText = includesNormalizedPhrase(textSentToTts, expectedSignals.signPhrase)
      && includesNormalizedPhrase(textSentToTts, expectedSignals.countersignPhrase);
    const semanticSignalInRecoveredAudio = includesNormalizedPhrase(responseTranscript, expectedSignals.signPhrase)
      && includesNormalizedPhrase(responseTranscript, expectedSignals.countersignPhrase);
    const semanticSignalPass = semanticSignalInTtsText && semanticSignalInRecoveredAudio;

    const stats = {
      outboundFrames: frames.length,
      playbackChunks: frames.filter((frame) => frame.type === 'playback.chunk').length,
      inputRuntimeMatch,
      outputMatch,
      semanticSignalPass,
    };

    console.log('\n=== Results ===');
    console.log(`Input phrase: ${INPUT_PHRASE}`);
    console.log(`Required sign phrase: ${expectedSignals.signPhrase}`);
    console.log(`Required countersign phrase: ${expectedSignals.countersignPhrase}`);
    console.log(`Input runtime match: ${inputRuntimeMatch.pass} (${inputRuntimeMatch.score.toFixed(2)} | ${inputRuntimeMatch.reason})`);
    console.log(`Output round-trip match: ${outputMatch.pass} (${outputMatch.score.toFixed(2)} | ${outputMatch.reason})`);
    console.log(`Semantic signal in text sent to TTS: ${semanticSignalInTtsText}`);
    console.log(`Semantic signal in recovered response audio: ${semanticSignalInRecoveredAudio}`);
    console.log(`Playback chunks: ${stats.playbackChunks}`);
    console.log(`Total outbound frames: ${stats.outboundFrames}`);

    if (!outputMatch.pass) {
      throw new Error(`Output round-trip mismatch: expected=\"${textSentToTts}\" actual=\"${responseTranscript}\"`);
    }
    if (!semanticSignalPass) {
      throw new Error(
        'Sign/countersign semantic check failed '
        + `(tts_has_signals=${semanticSignalInTtsText}, stt_has_signals=${semanticSignalInRecoveredAudio})`,
      );
    }

    console.log('\nPASS: Voice closed-loop round-trip + semantic sign/countersign validated.');
  } finally {
    await Promise.resolve(runtime.stop());
  }
}

main().catch((error) => {
  console.error('\nFAIL: Voice round-trip harness failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
