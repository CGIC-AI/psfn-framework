export interface CharacterCardV2 {
  spec: 'chara_card_v2';
  spec_version: string;
  data: CharacterData;
}

export interface CharacterData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  creator: string;
  creator_notes?: string;
  alternate_greetings?: string[];
  extensions?: Record<string, unknown>;
  character_version?: string;
}
