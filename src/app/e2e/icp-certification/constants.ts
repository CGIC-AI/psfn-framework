export const CERTIFICATION_COMPANION_A = 'a7100000-0000-4000-8000-000000000001';
export const CERTIFICATION_COMPANION_B = 'b7100000-0000-4000-8000-000000000002';
export const CERTIFICATION_COMPANION_C = 'c7100000-0000-4000-8000-000000000003';

export const CERTIFICATION_SCHEMA_A = 'certification_alpha';
export const CERTIFICATION_SCHEMA_B = 'certification_beta';

// Configured tenant owner roles (companions.json / support template). The agent
// runtime asserts each companion schema is owned by its configured role.
export const CERTIFICATION_ROLE_A = 'certification_alpha_runtime';
export const CERTIFICATION_ROLE_B = 'certification_beta_runtime';

export const CERTIFICATION_DM_CHANNEL =
  `companion-dm:${CERTIFICATION_COMPANION_A}:${CERTIFICATION_COMPANION_B}`;
export const CERTIFICATION_PRIVATE_ROOM = 'companion-room:certification_private_room';

export const CERTIFICATION_SESSION_KEYRING = {
  activeVersion: 'v1',
  keys: { v1: 'icp-certification-session-integrity-key' },
} as const;

export const CERTIFICATION_EMBEDDING_DIMS = 16;
