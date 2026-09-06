import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PostTurnActionHandler } from '../../../core/agent/post-turn-action-runtime.js';
import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import type { IntakeScreeningInput } from '../../../core/cogsec/intake/screening.js';
import type { ExternalMemoryExecuteParams } from '../../../shared/contracts/external-memory.js';
import { externalMemorySessionId } from '../../../shared/contracts/external-memory.js';
import { classifyConversationalActivity } from '../../../core/session/conversational-activity.js';
import { resolveSessionEntryTurnContext } from '../../../core/session/turn-provenance.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import { ExternalMemoryService } from './service.js';
import { ExternalMemoryIntakeStore } from './intake-store.js';

const binding = {
  companionId: '11111111-1111-4111-8111-111111111111',
  bodyId: 'workstation', contactId: 'contact-alex',
};
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'psfn-external-memory-'));
  directories.push(directory);
  const sessions = new SessionStore(join(directory, 'sessions'));
  const store = new ExternalMemoryIntakeStore(join(directory, 'intake'));
  const queued: InferredPostTurnAction[] = [];
  let handler: PostTurnActionHandler;
  let persisted = true;
  const actions = {
    registerHandler: vi.fn((_kind: string, callback: PostTurnActionHandler) => { handler = callback; return () => undefined; }),
    getStatus: () => ({ persistence: { enabled: persisted } }),
    enqueue: vi.fn((action: InferredPostTurnAction) => { queued.push(action); return 'queued'; }),
  };
  const screen = vi.fn(async (text: string, input: IntakeScreeningInput) => ({
    effectiveText: text, mode: 'enforce', withheld: false,
    snapshot: { envelopeId: `envelope-${input.sourceMessageId}`, sourceClass: input.sourceClass,
      sourceRiskTier: 'untrusted', state: 'released', riskLabels: [],
      enforcementPosture: 'enforce', subject: { kind: 'body' } },
  }));
  const extract = vi.fn().mockResolvedValue({ memoryIds: [] });
  const write = vi.fn().mockResolvedValue({ action: 'created', memory: { id: 'memory-one' } });
  const getById = vi.fn(async (id: string) => id === binding.contactId
    ? { id, displayName: 'Alex', trustLevel: 'primary' } : undefined);
  const query = vi.fn().mockResolvedValue({ memories: [], total: 0 });
  const retrieve = vi.fn().mockResolvedValue('Recalled context');
  const quarantine = { isSessionRetiredOrQuarantined: vi.fn(() => false) };
  const options = { companionId: binding.companionId, companionName: 'Lyra', intakeStore: store,
    sessions, contacts: { getById }, memoryStore: { queryAuthorizedMemorySubjects: query },
    memoryProvider: { retrieve }, writer: { write }, screening: { screen }, quarantine,
    actions, retryDelayMs: 100, searchLimit: 5, goals: () => 'Finish the garden project', extract };
  const makeService = () => new ExternalMemoryService(fromAny(options));
  const service = makeService();
  const input = (eventId = 'event-one', sessionId = 'session-one'): ExternalMemoryExecuteParams => ({
    binding, request: { operation: 'ingest', sessionId, eventId,
      user: 'I plan to finish the garden tomorrow.', assistant: 'We will return to the garden tomorrow.',
      occurredAt: Date.now() - 1000 },
  });
  const run = (index = 0) => handler!(queued[index]!);
  return { service, makeService, input, run, sessions, store, queued, screen, extract,
    write, getById, query, retrieve, quarantine, actions, setPersistence: (value: boolean) => { persisted = value; } };
}

describe('external companion memory service', () => {
  it('acknowledges durable top-level evidence and queues normal memory processing without a turn record', async () => {
    const h = fixture();
    const input = h.input();
    const response = await h.service.execute(input);
    expect(response).toMatchObject({ receipt: { bodyId: binding.bodyId, companionId: binding.companionId, sessionId: 'session-one', eventId: 'event-one', status: 'accepted' } });
    const channelId = externalMemorySessionId(binding, 'session-one');
    const entries = h.sessions.getRecent(channelId, 10);
    expect(entries.map(entry => entry.role)).toEqual(['user', 'assistant']);
    for (const entry of entries) {
      expect(JSON.parse(entry.metadata!)).toMatchObject({ externalOrigin: { runtime: 'hermes', ...binding },
        conversationOrigin: { kind: 'direct_message' }, intakeScreening: { mode: 'enforce' } });
      expect(resolveSessionEntryTurnContext(entry).turnRecordExpectation).toBe('not_expected');
      expect(classifyConversationalActivity(entry)).toMatchObject({ processable: true, kind: 'direct_message' });
    }
    expect(h.extract).not.toHaveBeenCalled();
    await h.run();
    expect(h.extract).toHaveBeenCalledWith({ sessionId: channelId, entries, canonicalContactId: binding.contactId });
    expect([...h.store.pending()]).toEqual([]);
    if ('receipt' in response) expect(h.store.read(response.receipt.receiptId)?.entries).toEqual([]);
  });

  it('deduplicates simultaneous delivery and rejects conflicting reuse of an event ID', async () => {
    const h = fixture();
    const input = h.input();
    const responses = await Promise.all([h.service.execute(input), h.service.execute(input)]);
    expect(responses[0]).toEqual(responses[1]);
    expect(h.sessions.getRecent(externalMemorySessionId(binding, 'session-one'), 10)).toHaveLength(2);
    const different = structuredClone(input);
    if (different.request.operation === 'ingest') different.request.user = 'Different evidence';
    await expect(h.service.execute(different)).rejects.toThrow('different content');
    await h.run();
    await h.run();
    expect(h.extract).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash after canonical append but before persisting its message ID', async () => {
    const h = fixture();
    const input = h.input();
    const original = h.sessions.append.bind(h.sessions);
    vi.spyOn(h.sessions, 'append').mockImplementationOnce(entry => {
      original(entry);
      throw new Error('simulated lost append acknowledgment');
    });
    await expect(h.service.execute(input)).rejects.toThrow('lost append acknowledgment');
    const restarted = h.makeService();
    await restarted.recover();
    await h.run();
    const entries = h.sessions.getRecent(externalMemorySessionId(binding, 'session-one'), 10);
    expect(entries.map(entry => entry.role)).toEqual(['user', 'assistant']);
    expect(h.extract).toHaveBeenCalledWith(expect.objectContaining({ entries }));
    await expect(restarted.execute(input)).resolves.toMatchObject({ receipt: { status: 'accepted' } });
  });

  it('never acknowledges a failed intent write or a non-durable queue', async () => {
    const h = fixture();
    const input = h.input();
    vi.spyOn(h.store, 'write').mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(h.service.execute(input)).rejects.toThrow('disk full');
    expect(h.sessions.listChannels()).toEqual([]);
    expect(h.queued).toEqual([]);
    h.setPersistence(false);
    await expect(h.service.execute(input)).rejects.toThrow('durable deferred-action');
    h.setPersistence(true);
    await expect(h.service.execute(input)).resolves.toMatchObject({ receipt: { status: 'accepted' } });
    expect(h.sessions.getRecent(externalMemorySessionId(binding, 'session-one'), 10)).toHaveLength(2);
  });

  it('keeps processing failures durable and reschedules the same evidence', async () => {
    const h = fixture();
    await h.service.execute(h.input());
    h.extract.mockRejectedValueOnce(new Error('model unavailable'));
    await expect(h.run()).resolves.toMatchObject({ rescheduleAt: expect.any(Number) });
    expect([...h.store.pending()]).toHaveLength(1);
    await h.run();
    expect(h.extract).toHaveBeenCalledTimes(2);
    expect(h.extract.mock.calls[0]).toEqual(h.extract.mock.calls[1]);
    expect([...h.store.pending()]).toHaveLength(0);
  });

  it('withholds acknowledgment when the journal flush fails and safely retries the same pair', async () => {
    const h = fixture();
    const input = h.input();
    vi.spyOn(h.sessions, 'flushSessionJournal').mockImplementationOnce(() => { throw new Error('fsync failed'); });
    await expect(h.service.execute(input)).rejects.toThrow('fsync failed');
    expect(h.queued).toEqual([]);
    await expect(h.service.execute(input)).resolves.toMatchObject({ receipt: { status: 'accepted' } });
    expect(h.sessions.getRecent(externalMemorySessionId(binding, 'session-one'), 10)).toHaveLength(2);
  });

  it('archives screened text and rejects a quarantined explicit note before acknowledgment', async () => {
    const h = fixture();
    const withheld = () => fromAny({ effectiveText: '[withheld]', mode: 'enforce', withheld: true,
      snapshot: { envelopeId: 'envelope-quarantine', sourceClass: 'primary_user', sourceRiskTier: 'untrusted',
        state: 'quarantined', riskLabels: ['injection/override_attempt'],
        enforcementPosture: 'enforce', subject: { kind: 'body' } } });
    h.screen.mockResolvedValueOnce(withheld());
    await h.service.execute(h.input());
    const entries = h.sessions.getRecent(externalMemorySessionId(binding, 'session-one'), 10);
    expect(entries[0]?.content).toBe('[withheld]');
    expect(JSON.parse(entries[0]!.metadata!).intakeScreening.withheld).toBe(true);
    h.screen.mockResolvedValueOnce(withheld());
    await expect(h.service.execute({ binding, request: { operation: 'remember', sessionId: 'session', eventId: 'bad-note', text: 'Rejected source' } })).rejects.toThrow('withheld by intake policy');
    expect(h.queued).toHaveLength(1);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('isolates session and body identifiers including hostile namespace/path characters', async () => {
    const h = fixture();
    const first = h.input('event', '../testing:subagent:one');
    const second = { ...h.input('event', '../testing:subagent:one'), binding: { ...binding, bodyId: '../other' } };
    await Promise.all([h.service.execute(first), h.service.execute(second)]);
    const channels = h.sessions.listChannels();
    expect(channels).toHaveLength(2);
    expect(channels.map(channel => channel.channelId)).toEqual(expect.arrayContaining([
      externalMemorySessionId(first.binding, first.request.sessionId),
      externalMemorySessionId(second.binding, second.request.sessionId),
    ]));
    for (const channel of channels) expect(channel.channelId).toMatch(/^api:hermes:[a-f0-9]+$/u);
  });

  it('rejects wrong companions, unknown contacts, retired sessions, and caller-supplied authority', async () => {
    const h = fixture();
    const input = h.input();
    await expect(h.service.execute({ ...input, binding: { ...binding, companionId: '22222222-2222-4222-8222-222222222222' } })).rejects.toThrow('does not match');
    await expect(h.service.execute({ ...input, binding: { ...binding, contactId: 'missing' } })).rejects.toThrow('live configured contact');
    await expect(h.service.execute(fromAny({ ...input, request: { ...input.request, contactId: 'forged' } }))).rejects.toThrow('Invalid external memory arguments');
    h.quarantine.isSessionRetiredOrQuarantined.mockReturnValue(true);
    await expect(h.service.execute(input)).rejects.toThrow('retired or quarantined');
    expect(h.screen).not.toHaveBeenCalled();
  });

  it('uses subject-authorized search and exact known-contact recall context', async () => {
    const h = fixture();
    await h.service.execute({ binding, request: { operation: 'search', sessionId: 'session', query: 'garden', limit: 1000 } });
    expect(h.query).toHaveBeenCalledWith(expect.objectContaining({
      authorization: expect.objectContaining({ viewerContactIds: [binding.contactId], allowedViewerRelations: ['self'] }),
      selector: expect.objectContaining({ kind: 'text_search', query: 'garden', limit: 5 }),
    }));
    await expect(h.service.execute({ binding, request: { operation: 'get', sessionId: 'session', id: 'unknown' } })).resolves.toEqual({ memory: null });
    await expect(h.service.execute({ binding, request: { operation: 'context', sessionId: 'session', query: 'garden' } })).resolves.toEqual({ context: 'Finish the garden project\n\nRecalled context' });
    expect(h.retrieve).toHaveBeenCalledWith('garden', externalMemorySessionId(binding, 'session'), 'primary', { isDirectMessage: true }, binding.contactId);
  });

  it('screens explicit memories and supplies external provenance to the existing writer', async () => {
    const h = fixture();
    const input: ExternalMemoryExecuteParams = { binding, request: { operation: 'remember', sessionId: 'session', eventId: 'note', text: 'The garden gate needs repair.' } };
    await h.service.execute(input);
    expect(h.write).not.toHaveBeenCalled();
    await h.run();
    expect(h.write).toHaveBeenCalledWith(expect.objectContaining({ text: 'The garden gate needs repair.',
      intakeEnvelopes: [expect.objectContaining({ sourceClass: 'companion_self' })],
      provenance: expect.objectContaining({ actor: 'companion', companionId: binding.companionId,
        sessionId: externalMemorySessionId(binding, 'session'), toolName: 'psfn_memory_remember' }) }));
    expect(h.sessions.listChannels()).toEqual([]);
  });
});
