export const CERTIFICATION_COMPANION_A = 'a7100000-0000-4000-8000-000000000001';
export const CERTIFICATION_COMPANION_B = 'b7100000-0000-4000-8000-000000000002';

export const CERTIFICATION_SCHEMA_A = 'shakedown_artie';
export const CERTIFICATION_SCHEMA_B = 'shakedown_support_mica';

export const CERTIFICATION_DM_CHANNEL =
  `companion-dm:${CERTIFICATION_COMPANION_A}:${CERTIFICATION_COMPANION_B}`;
export const CERTIFICATION_PRIVATE_ROOM = 'companion-room:certification_private_room';

export const CERTIFICATION_SESSION_KEYRING = {
  activeVersion: 'v1',
  keys: { v1: 'icp-certification-session-integrity-key' },
} as const;

export const CERTIFICATION_EMBEDDING_DIMS = 16;
