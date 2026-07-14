export const CERTIFICATION_COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CERTIFICATION_COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const CERTIFICATION_SCHEMA_A = 'certification_companion_a';
export const CERTIFICATION_SCHEMA_B = 'certification_companion_b';

export const CERTIFICATION_DM_CHANNEL =
  `companion-dm:${CERTIFICATION_COMPANION_A}:${CERTIFICATION_COMPANION_B}`;
export const CERTIFICATION_PRIVATE_ROOM = 'companion-room:certification_private_room';

export const CERTIFICATION_SESSION_KEYRING = {
  activeVersion: 'v1',
  keys: { v1: 'icp-certification-session-integrity-key' },
} as const;

export const CERTIFICATION_EMBEDDING_DIMS = 16;

