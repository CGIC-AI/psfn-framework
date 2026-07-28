import type { SkillsRuntime } from '../../../faculties/skills/runtime.js';
import type {
  AdminSkillsApi,
  ManagedSkillRecord,
} from '../admin-contract.js';
import type {
  SkillSkipRecord,
  SkillSnapshot,
} from '../../../faculties/skills/types.js';
import type { ConfigStorePort } from '../../../system/config/config-store.js';
import { SKILLS_FILE_NAME } from '../../../system/config/skills-config.js';
import { ownerFileScope } from '../../../system/config/settings-contract.js';

type SkillsConfigStore = Pick<ConfigStorePort, 'loadSkills' | 'saveSkills'>;

/**
 * Garden-owned adapter for operator skill administration.
 *
 * Managed skill documents remain delegated to SkillsRuntime. Operator-owned
 * enablement state is read and written only through the canonical owner-file
 * store so the model-facing runtime never receives a configuration mutation
 * surface.
 */
export class AdminSkillsDataService implements AdminSkillsApi {
  constructor(
    private readonly runtime: SkillsRuntime,
    private readonly configStore: SkillsConfigStore,
  ) {
    if (ownerFileScope(SKILLS_FILE_NAME) !== 'perCompanion') {
      throw new Error(`${SKILLS_FILE_NAME} must be registered as a per-companion owner file`);
    }
  }

  getSnapshot(): Promise<SkillSnapshot> {
    return this.runtime.getSnapshot();
  }

  listManaged(): Promise<{ managed: ManagedSkillRecord[]; skipped: SkillSkipRecord[] }> {
    return this.runtime.listManaged();
  }

  createSkill(input: {
    name: string;
    category: string;
    content: string;
    description?: string;
  }): ManagedSkillRecord {
    return this.runtime.createSkill(input);
  }

  updateSkill(input: {
    name: string;
    content: string;
    description?: string;
  }): ManagedSkillRecord {
    return this.runtime.updateSkill(input);
  }

  deleteSkill(name: string): void {
    this.runtime.deleteSkill(name);
  }

  toggleSkill(name: string): boolean {
    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new Error('Skill name is required');
    }

    const current = this.configStore.loadSkills();
    const wasDisabled = current.disabledSkills.includes(normalizedName);
    const disabledSkills = wasDisabled
      ? current.disabledSkills.filter(skillName => skillName !== normalizedName)
      : [...current.disabledSkills, normalizedName];

    this.configStore.saveSkills({
      ...current,
      disabledSkills,
    });
    this.runtime.invalidate();
    return wasDisabled;
  }

  getDisabledSkills(): string[] {
    return [...this.configStore.loadSkills().disabledSkills];
  }

  invalidate(): void {
    this.runtime.invalidate();
  }
}
