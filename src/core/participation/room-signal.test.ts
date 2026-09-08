import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultRoomSignalSettings,
  type RoomSignalSettings,
} from '../../system/config/participation-config.js';
import type { RoomObservation } from './room-observation.js';
import {
  RoomMessageFeatureExtractor,
  SharedRoomClassifier,
  evaluateRoomSignalEligibility,
  toRoomNomination,
  type RoomAmbiguityClassifierPort,
  type RoomClassificationClaimPort,
  type RoomCompanionProfile,
} from './room-signal.js';

function settings(overrides: Partial<RoomSignalSettings> = {}): RoomSignalSettings {
  return { ...createDefaultRoomSignalSettings(), enabled: true, ...overrides };
}

const PROFILE: RoomCompanionProfile = {
  companionId: 'companion-1',
  aliases: ['Lyra'],
  interests: ['persistence'],
};

function observation(overrides: Partial<RoomObservation> = {}): RoomObservation {
  return {
    schemaVersion: 1,
    connector: 'discord',
    channelType: 'discord',
    roomId: 'room-1',
    roomSize: 'unknown',
    roomVerified: true,
    messageId: 'message-1',
    timestampMs: 1_700_000_000_000,
    author: {
      authorId: 'human-1',
      displayName: 'Rae',
      isMachine: false,
      isObserver: false,
      sourceClass: 'primary_user',
      roomRole: 'member',
    },
    addressedByMention: false,
    addressedByReply: false,
    content: 'the migration is stuck again',
    ...overrides,
  };
}

const COMPANION_AUTHOR_IDS = ['bot-1'] as const;

function evaluate(
  input: {
    observation: RoomObservation;
    settings: RoomSignalSettings;
    profile?: RoomCompanionProfile;
    companionAuthorIds?: readonly string[];
  },
) {
  const extractor = new RoomMessageFeatureExtractor({ settings: input.settings });
  return evaluateRoomSignalEligibility({
    features: extractor.extract(input.observation),
    content: input.observation.content,
    companionAuthorIds: input.companionAuthorIds ?? COMPANION_AUTHOR_IDS,
    profile: input.profile ?? PROFILE,
    settings: input.settings,
  });
}

describe('RoomMessageFeatureExtractor', () => {
  it('derives one physical message exactly once, however many matchers ask', () => {
    const extractor = new RoomMessageFeatureExtractor({ settings: settings() });
    const first = extractor.extract(observation());
    const second = extractor.extract(observation());
    const third = extractor.extract(observation());
    // Identity, not just equality: no second derivation happened.
    expect(second).toBe(first);
    expect(third).toBe(first);
    // The velocity ring advanced once, not three times.
    expect(first.roomVelocity).toBe(1);
    expect(extractor.has('room-1', 'message-1')).toBe(true);
  });

  it('counts room velocity per room inside the trailing window only', () => {
    const config = settings({ velocityWindowMs: 60_000 });
    const extractor = new RoomMessageFeatureExtractor({ settings: config });
    const base = 1_700_000_000_000;
    extractor.extract(observation({ messageId: 'a', timestampMs: base }));
    extractor.extract(observation({ messageId: 'b', timestampMs: base + 1_000 }));
    const third = extractor.extract(observation({ messageId: 'c', timestampMs: base + 2_000 }));
    expect(third.roomVelocity).toBe(3);

    // A different room keeps its own ring.
    const other = extractor.extract(
      observation({ roomId: 'room-2', messageId: 'd', timestampMs: base + 2_000 }),
    );
    expect(other.roomVelocity).toBe(1);

    // Beyond the window, older activity no longer counts.
    const later = extractor.extract(
      observation({ messageId: 'e', timestampMs: base + 120_000 }),
    );
    expect(later.roomVelocity).toBe(1);
  });

  it('matches only reviewed coarse topic tags and carries no room text', () => {
    const config = settings({ topicTags: { persistence: ['migration', 'postgres'] } });
    const extractor = new RoomMessageFeatureExtractor({ settings: config });
    const features = extractor.extract(observation());
    expect(features.topicTags).toEqual(['persistence']);
    expect(JSON.stringify(features)).not.toContain('stuck again');
  });
});

describe('evaluateRoomSignalEligibility', () => {
  it('refuses everything while owner policy is off', () => {
    expect(evaluate({ observation: observation(), settings: settings({ enabled: false }) }))
      .toEqual({ outcome: 'ineligible', suppression: 'disabled' });
  });

  it('refuses an unverified room and the companion\'s own message', () => {
    expect(evaluate({ observation: observation({ roomVerified: false }), settings: settings() }))
      .toEqual({ outcome: 'ineligible', suppression: 'room_unverified' });
    expect(evaluate({
      observation: observation({
        author: { ...observation().author, isObserver: true },
      }),
      settings: settings(),
    })).toEqual({ outcome: 'ineligible', suppression: 'own_message' });
  });

  it('admits a connector mention or reply from any member, however untrusted', () => {
    const untrusted = {
      ...observation().author,
      sourceClass: 'public_contact' as const,
      roomRole: 'unknown' as const,
    };
    expect(evaluate({
      observation: observation({ author: untrusted, addressedByMention: true }),
      settings: settings(),
    })).toEqual({
      outcome: 'eligible',
      trigger: 'direct_mention',
      reasonCodes: ['connector_mention'],
    });
    expect(evaluate({
      observation: observation({ author: untrusted, addressedByReply: true }),
      settings: settings(),
    })).toMatchObject({ outcome: 'eligible', reasonCodes: ['connector_reply'] });
  });

  it('admits a reviewed alias opening the line as a direct address', () => {
    expect(evaluate({
      observation: observation({ content: 'Lyra can you look at the migration?' }),
      settings: settings(),
    })).toEqual({
      outcome: 'eligible',
      trigger: 'direct_mention',
      reasonCodes: ['alias_leading_address'],
    });
  });

  it('keeps untrusted and unknown room members direct-address-only', () => {
    const untrusted = observation({
      author: {
        ...observation().author,
        sourceClass: 'public_contact',
        roomRole: 'unknown',
      },
      content: 'someone said Lyra knows about this',
    });
    expect(evaluate({ observation: untrusted, settings: settings() }))
      .toEqual({ outcome: 'ineligible', suppression: 'untrusted_room_member' });

    // The same member becomes contextually eligible only once owner policy
    // admits their verified role.
    expect(evaluate({
      observation: {
        ...untrusted,
        author: { ...untrusted.author, roomRole: 'moderator' },
      },
      settings: settings({ contextualEligibleRoomRoles: ['moderator'] }),
    })).toMatchObject({ outcome: 'eligible', trigger: 'passive_name' });
  });

  it('stops contextual participation in a flooding room', () => {
    const config = settings({ maxRoomVelocity: 2, topicTags: { persistence: ['migration'] } });
    const extractor = new RoomMessageFeatureExtractor({ settings: config });
    const base = 1_700_000_000_000;
    let last;
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      last = evaluateRoomSignalEligibility({
        features: extractor.extract(observation({ messageId: id, timestampMs: base + index })),
        content: 'the migration is stuck again',
        companionAuthorIds: COMPANION_AUTHOR_IDS,
        profile: PROFILE,
        settings: config,
      });
    }
    expect(last).toEqual({ outcome: 'ineligible', suppression: 'room_velocity' });
  });

  it('nominates on a reviewed topic the companion is responsible for', () => {
    expect(evaluate({
      observation: observation(),
      settings: settings({ topicTags: { persistence: ['migration'] } }),
    })).toEqual({
      outcome: 'eligible',
      trigger: 'contextual_continuation',
      reasonCodes: ['trusted_source_class', 'topic_match'],
    });
  });

  it('refuses a reviewed topic outside the companion\'s responsibilities', () => {
    expect(evaluate({
      observation: observation(),
      settings: settings({ topicTags: { infrastructure: ['migration'] } }),
    })).toEqual({ outcome: 'ineligible', suppression: 'topic_mismatch' });
  });

  it('reports ambiguity only when the reviewed vocabulary cannot decide', () => {
    expect(evaluate({
      observation: observation({ content: 'what do we do about that thing' }),
      settings: settings({ topicTags: { persistence: ['migration'] } }),
    })).toEqual({ outcome: 'ambiguous', reasonCodes: ['trusted_source_class'] });
  });
});

// psfn-framework-vprcm. Room signal used to carry its own alias matcher whose
// boundary rules differed from the canonical `detectCompanionNameMatch` used by
// group-memory salience and the passive-name gate. These cases pin the single
// detector: the addressing forms the local matcher dropped are now admitted,
// and the one form it over-matched is now refused the same way everywhere else.
describe('evaluateRoomSignalEligibility canonical name detection', () => {
  const untrustedAuthor = {
    ...observation().author,
    sourceClass: 'public_contact' as const,
    roomRole: 'unknown' as const,
  };

  it('admits a bare platform mention with no alias text as a direct address', () => {
    // The old local matcher only read alias prose, so a first-contact line that
    // addressed the companion by its connector id alone was ambient chatter.
    expect(evaluate({
      observation: observation({ author: untrustedAuthor, content: '<@bot-1> can you look?' }),
      settings: settings(),
    })).toEqual({
      outcome: 'eligible',
      trigger: 'direct_mention',
      reasonCodes: ['alias_leading_address'],
    });
  });

  it('admits an alias followed by punctuation as a direct address', () => {
    // `startsWith('lyra ')` missed every "Lyra, ..." opening; the canonical
    // normalizer strips the comma before matching.
    expect(evaluate({
      observation: observation({ author: untrustedAuthor, content: 'Lyra, can you help?' }),
      settings: settings(),
    })).toEqual({
      outcome: 'eligible',
      trigger: 'direct_mention',
      reasonCodes: ['alias_leading_address'],
    });
  });

  it('reads a mid-line platform mention as a mention, not an opening address', () => {
    expect(evaluate({
      observation: observation({ content: 'ask <@bot-1> about the migration' }),
      settings: settings({ topicTags: { persistence: ['migration'] } }),
    })).toMatchObject({
      outcome: 'eligible',
      trigger: 'passive_name',
      reasonCodes: expect.arrayContaining(['alias_mention']),
    });
  });

  it('no longer treats a possessive as a bare alias mention', () => {
    // Divergence in the other direction, accepted deliberately: the canonical
    // normalizer keeps the apostrophe inside the token, so "lyra's" is one word
    // and does not match the alias. Group-memory salience already behaved this
    // way; room signal now agrees instead of scoring it more permissively.
    expect(evaluate({
      observation: observation({ author: untrustedAuthor, content: "that was lyra's call" }),
      settings: settings(),
    })).toEqual({ outcome: 'ineligible', suppression: 'untrusted_room_member' });
  });

  it('reads the same line identically on every connector', () => {
    // Cross-connector parity: nothing in the staged decision may depend on
    // which adapter translated the event.
    const connectors = ['discord', 'telegram', 'buzz'] as const;
    for (const content of [
      'Lyra, can you help?',
      '<@bot-1> can you look?',
      'ask lyra about it later',
      'nothing to see here',
    ]) {
      const results = connectors.map(connector => evaluate({
        observation: observation({
          connector,
          channelType: connector,
          author: untrustedAuthor,
          content,
        }),
        settings: settings(),
      }));
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
    }
  });

  it('gives an untrusted author the same direct-address-only bar on every connector', () => {
    // The Buzz trust floor now matches Discord/Telegram (a room author the
    // connector cannot vouch for is `public_contact`), so the same untrusted
    // author is admitted only when actually addressed — never contextually.
    for (const connector of ['discord', 'telegram', 'buzz'] as const) {
      expect(evaluate({
        observation: observation({
          connector,
          channelType: connector,
          author: untrustedAuthor,
          content: 'the migration is stuck again',
        }),
        settings: settings({ topicTags: { persistence: ['migration'] } }),
      })).toEqual({ outcome: 'ineligible', suppression: 'untrusted_room_member' });

      expect(evaluate({
        observation: observation({
          connector,
          channelType: connector,
          author: untrustedAuthor,
          content: 'Lyra, the migration is stuck again',
        }),
        settings: settings({ topicTags: { persistence: ['migration'] } }),
      })).toMatchObject({ outcome: 'eligible', trigger: 'direct_mention' });
    }
  });
});

describe('toRoomNomination', () => {
  it('carries ids, codes, and counters — never text, aliases, or interests', () => {
    const config = settings({ topicTags: { persistence: ['migration'] } });
    const extractor = new RoomMessageFeatureExtractor({ settings: config });
    const nomination = toRoomNomination({
      features: extractor.extract(observation()),
      companionId: PROFILE.companionId,
      trigger: 'contextual_continuation',
      reasonCodes: ['trusted_source_class', 'topic_match'],
      classifierConsulted: false,
    });
    const serialized = JSON.stringify(nomination);
    for (const secret of ['stuck again', 'Lyra', 'Rae', 'migration']) {
      expect(serialized).not.toContain(secret);
    }
    expect(nomination).toEqual({
      schemaVersion: 1,
      companionId: 'companion-1',
      roomId: 'room-1',
      messageId: 'message-1',
      timestampMs: 1_700_000_000_000,
      connector: 'discord',
      trigger: 'contextual_continuation',
      reasonCodes: ['trusted_source_class', 'topic_match'],
      classifierConsulted: false,
    });
  });
});

describe('SharedRoomClassifier', () => {
  function makeClassifier(options: {
    settings: RoomSignalSettings;
    claim?: RoomClassificationClaimPort;
    relevant?: boolean;
  }) {
    const classify = vi.fn<RoomAmbiguityClassifierPort['classify']>(
      async () => ({ relevant: options.relevant ?? true }),
    );
    const claim = options.claim ?? { claim: async () => true };
    return {
      classify,
      shared: new SharedRoomClassifier({
        classifier: { classify },
        claims: claim,
        settings: options.settings,
      }),
    };
  }

  const config = settings({
    classifier: { ...createDefaultRoomSignalSettings().classifier, enabled: true },
  });

  it('evaluates one physical message at most once across many companions', async () => {
    const { classify, shared } = makeClassifier({ settings: config });
    const extractor = new RoomMessageFeatureExtractor({ settings: config });
    const features = extractor.extract(observation());

    const verdicts = await Promise.all([1, 2, 3, 4].map(async () => await shared.resolve({
      features,
      content: 'what do we do about that thing',
      interests: PROFILE.interests,
    })));

    expect(verdicts).toEqual([
      { outcome: 'relevant' },
      { outcome: 'relevant' },
      { outcome: 'relevant' },
      { outcome: 'relevant' },
    ]);
    expect(classify).toHaveBeenCalledTimes(1);

    // A second, genuinely different message is its own single evaluation.
    await shared.resolve({
      features: extractor.extract(observation({ messageId: 'message-2' })),
      content: 'another ambiguous line',
      interests: PROFILE.interests,
    });
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('truncates the excerpt to the owner-owned cap before any call', async () => {
    const capped = settings({
      classifier: { ...config.classifier, excerptChars: 10 },
    });
    const { classify, shared } = makeClassifier({ settings: capped });
    const extractor = new RoomMessageFeatureExtractor({ settings: capped });
    await shared.resolve({
      features: extractor.extract(observation()),
      content: 'a very long ambient room line that must never be sent whole',
      interests: PROFILE.interests,
    });
    expect(classify.mock.calls[0]?.[0].excerpt).toBe('a very lon');
  });

  it('runs nothing when the classifier is disabled by owner policy', async () => {
    const { classify, shared } = makeClassifier({ settings: settings() });
    const extractor = new RoomMessageFeatureExtractor({ settings: settings() });
    expect(await shared.resolve({
      features: extractor.extract(observation()),
      content: 'ambiguous',
      interests: PROFILE.interests,
    })).toEqual({ outcome: 'unavailable' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('runs nothing and stays unavailable when the claim is lost', async () => {
    const { classify, shared } = makeClassifier({
      settings: config,
      claim: { claim: async () => false },
    });
    const extractor = new RoomMessageFeatureExtractor({ settings: config });
    expect(await shared.resolve({
      features: extractor.extract(observation()),
      content: 'ambiguous',
      interests: PROFILE.interests,
    })).toEqual({ outcome: 'unavailable' });
    expect(classify).not.toHaveBeenCalled();
  });
});
