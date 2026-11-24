// ── Personal-projects port (free-time lane) ──
//
// Core-owned structural port satisfied by the host wiki's PersonalProjectLibrary
// (`faculties/wiki/personal-projects.ts`). Standalone / Lite deployments without
// the wiki subsystem inject `EMPTY_PERSONAL_PROJECTS`.

export type PersonalProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

/** Publication/review mode for a publication work context (bible §10.9/§10.10). */
export type ProjectPublicationMode = 'public_clean' | 'expressive_review';

/**
 * The DM return anchor for private, contact-anchored free-time work (bible
 * §10.6/§10.8). The manifest stores only the stable `contactId`; the concrete DM
 * `channelId` is resolved by the return-note routing at projection time.
 */
export interface ProjectContactDmTarget {
  contactId: string;
  channelId?: string;
}

/**
 * A project's durable, companion-owned work context (bible §10.3/§10.5).
 */
export type PersonalProjectWorkContext =
  | { kind: 'private'; returnTarget?: ProjectContactDmTarget }
  | { kind: 'room'; channelId: string }
  | { kind: 'publication'; mode: ProjectPublicationMode; surfaceRef?: string };

/** The manifest fields the free-time lane reads (a subset of PersonalProjectManifest). */
export interface PersonalProjectSummary {
  ref: string;
  title: string;
  status: PersonalProjectStatus;
  workContext: PersonalProjectWorkContext;
  nextStep: string;
}

export interface PersonalProjectsPort {
  listProjects(): readonly PersonalProjectSummary[];
  resumeNextActiveProject(): Promise<{ context: string } | null>;
}

/** No personal projects: empty library when the host wiki subsystem is absent. */
export const EMPTY_PERSONAL_PROJECTS: PersonalProjectsPort = Object.freeze({
  listProjects: () => [],
  resumeNextActiveProject: async () => null,
});
