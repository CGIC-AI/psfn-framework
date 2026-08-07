export interface ReflectionPublishInput {
  templateId: string;
  templateName: string;
  reflection: string;
  mode: 'agent' | 'deliberation';
  createdAt: Date;
}
