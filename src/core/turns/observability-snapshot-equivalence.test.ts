import { describe, expect, it } from 'vitest';
import { cloneTurnSnapshotRecord, sanitizeTurnSnapshot } from './observability.js';
import type { TurnSnapshotRecord } from './observability.js';
import type { TurnSnapshot } from './snapshot.js';
import type { PurrMemory } from '../../faculties/memory/types.js';

/**
 * Bead psfn-framework-yqr1m: byte- and shape-equivalence fixtures pinning the
 * sanitize (live TurnSnapshot -> record) and clone (record -> record) paths so
 * the shared nested cloners cannot drift either projection.
 *
 * Generic fixture strings only.
 */

function memory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `memory ${id}`,
    type: 'fact',
    importance: 0.5,
    confidence: 0.75,
    emotionalValence: 0,
    salience: 0.25,
    embedding: new Float32Array([0.1, 0.2]),
    sourceRef: `source-${id}`,
    extractedAt: 100,
    lastAccessed: 200,
    accessCount: 3,
    tags: ['tag-a', 'tag-b'],
    provenanceRefs: ['ref-1'],
    consentFlags: { shareable: true } as PurrMemory['consentFlags'],
    formationVAD: { valence: 0.1, arousal: 0.2, dominance: 0.3 } as PurrMemory['formationVAD'],
    sensitivity: 'personal',
    ...overrides,
  };
}

function buildFullSnapshot(): TurnSnapshot {
  return {
    turnId: 'turn-full' as TurnSnapshot['turnId'],
    requestId: 'request-full',
    channelId: 'api:fixture',
    capturedAt: 1_000,
    trustLevel: 'regular',
    canonicalContactKey: 'contact:fixture',
    prompt: {
      staticPrefixTemplate: 'static',
      dynamicSuffixTemplate: 'dynamic',
      dynamicSuffixSections: [{ identifier: 'layer-1', required: true, content: 'layer content' }],
      staticHash: 'hash',
      versionPointer: 'prompt-v1',
      sectionCacheability: [
        { section: 'staticPrefixTemplate', cacheability: 'static', cacheBreakers: ['prompt_layer'], reason: 'static' },
      ],
    },
    promptContext: {
      currentTurnInput: '',
      response: { content: 'reply', model: 'fixture-model', toolCallCount: 0 },
      inputSections: [{ id: 'in', title: 'Input', content: 'input', charCount: 5, tokenCount: 1 }],
      runtimeContextSections: [{ id: 'rt', title: 'Runtime', content: 'runtime', charCount: 7, tokenCount: 2 }],
      memoryContextSections: [{ id: 'mem', title: 'Memory', content: 'memory', charCount: 6, tokenCount: 1 }],
      finalSystemSections: [{ id: 'fin', title: 'Final', content: 'final', charCount: 5, tokenCount: 1 }],
      sectionCacheability: [
        { section: 'messages', cacheability: 'append_only', cacheBreakers: ['session_history'], reason: 'append' },
      ],
    },
    toolContext: {
      activeTools: [
        {
          name: 'fixture_tool',
          description: 'Fixture tool',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        },
      ],
    },
    sessionContext: {
      channelId: 'api:fixture',
      recentEntries: [{ id: 1, channelId: 'api:fixture', role: 'user', content: 'hi', timestamp: 10 }],
      autoCompactionEligible: false,
      sourceEntryCount: 0,
      rolledOutSessionBoundary: { sessionId: 'session-old', beforeMs: 5 },
      storeWindowMaxEntryId: 1,
      roomWindowFloorMs: 4,
      bondedMemberChannelIds: ['api:bonded'],
      historySummaryText: 'summary',
      historySummaryEntryCount: 0,
      compactionSummaryTexts: ['compaction'],
      focusKnowledgeTexts: ['focus'],
      continuityEntries: [{ id: 2, channelId: 'api:fixture', role: 'assistant', content: 'yo', timestamp: 11 }],
      wakeReturnArtifacts: [],
      intentionAppraisalArtifactCount: 0,
      compactionPromptText: '',
      versionPointer: 'session-v1',
    },
    memory: {
      channelId: 'api:fixture',
      recentContactShape: {
        schemaVersion: 1,
        contactId: 'contact',
        summary: 'shape',
        sourceMemoryIds: ['m-1'],
        confidenceScore: 0.5,
        noveltyScore: 0.5,
        updatedAt: 1,
        freshUntil: 2,
      },
      emotionalSnapshot: { baselineValence: 0, moodValence: 0.1, moodDrift: 0, moodSamples: 1 },
      contactEmotionalMemories: [memory('m-1'), memory('m-withheld')],
      semanticCandidates: [{ ...memory('m-2', { provenanceRefs: undefined }), similarity: 0.9 }],
      lexicalCandidates: [{ ...memory('m-3', { consentFlags: undefined, formationVAD: undefined }), similarity: 0.4 }],
      episodicChains: [],
      proactiveCandidates: [memory('m-4')],
      withheldSummary: { totalCount: 1, reasonCounts: {} as never },
      withheldCandidateIds: ['m-withheld'],
      versionPointer: 'memory-v1',
    },
    biographicalProjection: { admittedClaimIds: ['claim-1'], withheldCount: 2, contextChars: 30 },
    fatigue: { schemaVersion: 1, overchargeReasons: ['r1'], nested: { list: [1, 2] } } as unknown as TurnSnapshot['fatigue'],
  };
}

function buildMinimalSnapshot(): TurnSnapshot {
  return {
    turnId: 'turn-min' as TurnSnapshot['turnId'],
    requestId: 'request-min',
    channelId: 'api:fixture',
    capturedAt: 2_000,
    trustLevel: 'regular',
    canonicalContactKey: '',
    prompt: { staticPrefixTemplate: '', dynamicSuffixTemplate: '', staticHash: '', versionPointer: 'p' },
    promptContext: {},
    toolContext: {},
    sessionContext: {
      channelId: 'api:fixture',
      recentEntries: [],
      historySummaryText: '',
      compactionSummaryTexts: [],
      focusKnowledgeTexts: [],
      continuityEntries: [],
      versionPointer: 's',
    },
    memory: {
      channelId: 'api:fixture',
      contactEmotionalMemories: [],
      semanticCandidates: [],
      lexicalCandidates: [],
      proactiveCandidates: [],
      versionPointer: 'm',
    },
  };
}

describe('turn snapshot sanitize/clone equivalence fixtures', () => {
  it('sanitizes a fully populated snapshot to a pinned byte shape and clones it byte-identically', () => {
    const sanitized = sanitizeTurnSnapshot(buildFullSnapshot());
    const bytes = JSON.stringify(sanitized);
    expect(JSON.stringify(sanitized, null, 2)).toMatchInlineSnapshot(`
      "{
        "turnId": "turn-full",
        "requestId": "request-full",
        "channelId": "api:fixture",
        "capturedAt": 1000,
        "trustLevel": "regular",
        "canonicalContactKey": "contact:fixture",
        "prompt": {
          "staticPrefixTemplate": "static",
          "dynamicSuffixTemplate": "dynamic",
          "dynamicSuffixSections": [
            {
              "identifier": "layer-1",
              "required": true,
              "content": "layer content"
            }
          ],
          "staticHash": "hash",
          "versionPointer": "prompt-v1",
          "sectionCacheability": [
            {
              "section": "staticPrefixTemplate",
              "cacheability": "static",
              "cacheBreakers": [
                "prompt_layer"
              ],
              "reason": "static"
            }
          ]
        },
        "promptContext": {
          "currentTurnInput": "",
          "response": {
            "content": "reply",
            "model": "fixture-model",
            "toolCallCount": 0
          },
          "inputSections": [
            {
              "id": "in",
              "title": "Input",
              "content": "input",
              "charCount": 5,
              "tokenCount": 1
            }
          ],
          "runtimeContextSections": [
            {
              "id": "rt",
              "title": "Runtime",
              "content": "runtime",
              "charCount": 7,
              "tokenCount": 2
            }
          ],
          "memoryContextSections": [
            {
              "id": "mem",
              "title": "Memory",
              "content": "memory",
              "charCount": 6,
              "tokenCount": 1
            }
          ],
          "finalSystemSections": [
            {
              "id": "fin",
              "title": "Final",
              "content": "final",
              "charCount": 5,
              "tokenCount": 1
            }
          ],
          "sectionCacheability": [
            {
              "section": "messages",
              "cacheability": "append_only",
              "cacheBreakers": [
                "session_history"
              ],
              "reason": "append"
            }
          ]
        },
        "toolContext": {
          "activeTools": [
            {
              "name": "fixture_tool",
              "description": "Fixture tool",
              "inputSchema": {
                "type": "object",
                "properties": {
                  "q": {
                    "type": "string"
                  }
                },
                "required": [
                  "q"
                ]
              }
            }
          ]
        },
        "sessionContext": {
          "channelId": "api:fixture",
          "recentEntries": [
            {
              "id": 1,
              "channelId": "api:fixture",
              "role": "user",
              "content": "hi",
              "timestamp": 10
            }
          ],
          "autoCompactionEligible": false,
          "sourceEntryCount": 0,
          "rolledOutSessionBoundary": {
            "sessionId": "session-old",
            "beforeMs": 5
          },
          "historySummaryText": "summary",
          "historySummaryEntryCount": 0,
          "compactionSummaryTexts": [
            "compaction"
          ],
          "focusKnowledgeTexts": [
            "focus"
          ],
          "continuityEntries": [
            {
              "id": 2,
              "channelId": "api:fixture",
              "role": "assistant",
              "content": "yo",
              "timestamp": 11
            }
          ],
          "wakeReturnArtifacts": [],
          "intentionAppraisalArtifactCount": 0,
          "versionPointer": "session-v1"
        },
        "memory": {
          "channelId": "api:fixture",
          "recentContactShape": {
            "schemaVersion": 1,
            "contactId": "contact",
            "summary": "shape",
            "sourceMemoryIds": [
              "m-1"
            ],
            "confidenceScore": 0.5,
            "noveltyScore": 0.5,
            "updatedAt": 1,
            "freshUntil": 2
          },
          "emotionalSnapshot": {
            "baselineValence": 0,
            "moodValence": 0.1,
            "moodDrift": 0,
            "moodSamples": 1
          },
          "contactEmotionalMemories": [
            {
              "id": "m-1",
              "text": "memory m-1",
              "type": "fact",
              "importance": 0.5,
              "confidence": 0.75,
              "emotionalValence": 0,
              "salience": 0.25,
              "sourceRef": "source-m-1",
              "extractedAt": 100,
              "lastAccessed": 200,
              "accessCount": 3,
              "tags": [
                "tag-a",
                "tag-b"
              ],
              "provenanceRefs": [
                "ref-1"
              ],
              "consentFlags": {
                "shareable": true
              },
              "formationVAD": {
                "valence": 0.1,
                "arousal": 0.2,
                "dominance": 0.3
              },
              "sensitivity": "personal"
            }
          ],
          "semanticCandidates": [
            {
              "id": "m-2",
              "text": "memory m-2",
              "type": "fact",
              "importance": 0.5,
              "confidence": 0.75,
              "emotionalValence": 0,
              "salience": 0.25,
              "sourceRef": "source-m-2",
              "extractedAt": 100,
              "lastAccessed": 200,
              "accessCount": 3,
              "tags": [
                "tag-a",
                "tag-b"
              ],
              "consentFlags": {
                "shareable": true
              },
              "formationVAD": {
                "valence": 0.1,
                "arousal": 0.2,
                "dominance": 0.3
              },
              "sensitivity": "personal",
              "similarity": 0.9
            }
          ],
          "lexicalCandidates": [
            {
              "id": "m-3",
              "text": "memory m-3",
              "type": "fact",
              "importance": 0.5,
              "confidence": 0.75,
              "emotionalValence": 0,
              "salience": 0.25,
              "sourceRef": "source-m-3",
              "extractedAt": 100,
              "lastAccessed": 200,
              "accessCount": 3,
              "tags": [
                "tag-a",
                "tag-b"
              ],
              "provenanceRefs": [
                "ref-1"
              ],
              "sensitivity": "personal",
              "similarity": 0.4
            }
          ],
          "episodicChains": [],
          "proactiveCandidates": [
            {
              "id": "m-4",
              "text": "memory m-4",
              "type": "fact",
              "importance": 0.5,
              "confidence": 0.75,
              "emotionalValence": 0,
              "salience": 0.25,
              "sourceRef": "source-m-4",
              "extractedAt": 100,
              "lastAccessed": 200,
              "accessCount": 3,
              "tags": [
                "tag-a",
                "tag-b"
              ],
              "provenanceRefs": [
                "ref-1"
              ],
              "consentFlags": {
                "shareable": true
              },
              "formationVAD": {
                "valence": 0.1,
                "arousal": 0.2,
                "dominance": 0.3
              },
              "sensitivity": "personal"
            }
          ],
          "withheldSummary": {
            "totalCount": 1,
            "reasonCounts": {}
          },
          "versionPointer": "memory-v1"
        },
        "biographicalProjection": {
          "admittedClaimIds": [
            "claim-1"
          ],
          "withheldCount": 2,
          "contextChars": 30
        },
        "fatigue": {
          "schemaVersion": 1,
          "overchargeReasons": [
            "r1"
          ],
          "nested": {
            "list": [
              1,
              2
            ]
          }
        }
      }"
    `);
    expect(JSON.stringify(cloneTurnSnapshotRecord(sanitized))).toBe(bytes);
  });

  it('preserves absent and falsy optional fields exactly on both paths', () => {
    const sanitized = sanitizeTurnSnapshot(buildMinimalSnapshot());
    const bytes = JSON.stringify(sanitized);
    expect(JSON.stringify(sanitized, null, 2)).toMatchInlineSnapshot(`
      "{
        "turnId": "turn-min",
        "requestId": "request-min",
        "channelId": "api:fixture",
        "capturedAt": 2000,
        "trustLevel": "regular",
        "prompt": {
          "staticPrefixTemplate": "",
          "dynamicSuffixTemplate": "",
          "staticHash": "",
          "versionPointer": "p"
        },
        "promptContext": {},
        "toolContext": {},
        "sessionContext": {
          "channelId": "api:fixture",
          "recentEntries": [],
          "compactionSummaryTexts": [],
          "focusKnowledgeTexts": [],
          "continuityEntries": [],
          "versionPointer": "s"
        },
        "memory": {
          "channelId": "api:fixture",
          "contactEmotionalMemories": [],
          "semanticCandidates": [],
          "lexicalCandidates": [],
          "proactiveCandidates": [],
          "versionPointer": "m"
        }
      }"
    `);
    expect(sanitized.toolContext).toEqual({});
    expect(sanitized.toolContext && 'activeTools' in sanitized.toolContext).toBe(false);
    expect('plan' in sanitized).toBe(false);
    expect('fatigue' in sanitized).toBe(false);
    expect('biographicalProjection' in sanitized).toBe(false);
    expect(JSON.stringify(cloneTurnSnapshotRecord(sanitized))).toBe(bytes);
  });

  it('keeps the distinct sanitize-versus-clone semantics', () => {
    const sanitized = sanitizeTurnSnapshot(buildFullSnapshot());
    // Sanitize filters withheld candidates, strips embeddings, and projects only record fields.
    expect(sanitized.memory?.contactEmotionalMemories.map(entry => entry.id)).toEqual(['m-1']);
    expect(sanitized.memory && 'embedding' in sanitized.memory.contactEmotionalMemories[0]!).toBe(false);
    expect(sanitized.memory && 'withheldCandidateIds' in sanitized.memory).toBe(false);
    expect(sanitized.sessionContext && 'storeWindowMaxEntryId' in sanitized.sessionContext).toBe(false);

    // Clone does not re-filter and preserves extra top-level record fields.
    const record = {
      ...sanitized,
      extraTopLevel: 'kept',
    } as TurnSnapshotRecord & { extraTopLevel: string };
    record.memory!.contactEmotionalMemories.push({ ...record.memory!.contactEmotionalMemories[0]!, id: 'm-withheld' });
    const cloned = cloneTurnSnapshotRecord(record) as TurnSnapshotRecord & { extraTopLevel?: string };
    expect(cloned.extraTopLevel).toBe('kept');
    expect(cloned.memory?.contactEmotionalMemories.map(entry => entry.id)).toEqual(['m-1', 'm-withheld']);
  });

  it('isolates every nested array and record from later source mutation', () => {
    const source = buildFullSnapshot();
    const sanitized = sanitizeTurnSnapshot(source);
    const sanitizedBytes = JSON.stringify(sanitized);
    const cloned = cloneTurnSnapshotRecord(sanitized);

    source.prompt!.sectionCacheability![0]!.cacheBreakers.push('mutated');
    source.promptContext!.inputSections![0]!.content = 'mutated';
    source.promptContext!.sectionCacheability![0]!.cacheBreakers.push('mutated');
    source.toolContext!.activeTools![0]!.name = 'mutated';
    source.sessionContext!.recentEntries[0]!.content = 'mutated';
    source.sessionContext!.recentEntries.push({ id: 9, channelId: 'x', role: 'user', content: 'x', timestamp: 0 });
    source.sessionContext!.compactionSummaryTexts.push('mutated');
    source.sessionContext!.focusKnowledgeTexts.push('mutated');
    source.sessionContext!.continuityEntries[0]!.content = 'mutated';
    source.memory!.recentContactShape!.sourceMemoryIds.push('mutated');
    source.memory!.emotionalSnapshot!.moodDrift = 99;
    source.memory!.contactEmotionalMemories[0]!.tags.push('mutated');
    source.memory!.contactEmotionalMemories[0]!.provenanceRefs!.push('mutated');
    source.memory!.semanticCandidates[0]!.tags.push('mutated');
    source.memory!.proactiveCandidates[0]!.tags.push('mutated');
    source.biographicalProjection!.admittedClaimIds.push('mutated');
    (source.fatigue as unknown as { nested: { list: number[] } }).nested.list.push(3);
    expect(JSON.stringify(sanitized)).toBe(sanitizedBytes);

    sanitized.prompt!.sectionCacheability![0]!.cacheBreakers.push('mutated');
    sanitized.promptContext!.inputSections![0]!.content = 'mutated';
    sanitized.toolContext!.activeTools![0]!.name = 'mutated';
    sanitized.sessionContext!.recentEntries[0]!.content = 'mutated';
    sanitized.sessionContext!.compactionSummaryTexts.push('mutated');
    sanitized.memory!.recentContactShape!.sourceMemoryIds.push('mutated');
    sanitized.memory!.contactEmotionalMemories[0]!.tags.push('mutated');
    sanitized.memory!.contactEmotionalMemories[0]!.consentFlags!.shareable = false;
    sanitized.memory!.lexicalCandidates[0]!.tags.push('mutated');
    sanitized.biographicalProjection!.admittedClaimIds.push('mutated');
    (sanitized.fatigue as unknown as { nested: { list: number[] } }).nested.list.push(3);
    expect(JSON.stringify(cloned)).toBe(sanitizedBytes);
  });
});
