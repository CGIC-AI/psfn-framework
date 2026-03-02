export type ChatDebugEventName =
  | 'agent.turn.start'
  | 'agent.turn.stage'
  | 'agent.turn.end'
  | 'agent.stream.thinking'
  | 'agent.stream.delta'
  | 'agent.tool.start'
  | 'agent.tool.end'
  | 'memory.extraction.start'
  | 'memory.extraction.end'
  | 'memory.retrieval'
  | 'agent.error'
  | 'channel.voice.error'
  | 'voice.turn.error'
  | 'wyoming.session.start'
  | 'wyoming.session.end'
  | 'wyoming.connection.error'
  | 'wyoming.policy.violation'
  | 'wyoming.audit.summary'
  | 'system.error';

export const CHAT_DEBUG_EVENTS: ChatDebugEventName[] = [
  'agent.turn.start',
  'agent.turn.stage',
  'agent.turn.end',
  'agent.stream.thinking',
  'agent.stream.delta',
  'agent.tool.start',
  'agent.tool.end',
  'memory.extraction.start',
  'memory.extraction.end',
  'memory.retrieval',
  'agent.error',
  'channel.voice.error',
  'voice.turn.error',
  'wyoming.session.start',
  'wyoming.session.end',
  'wyoming.connection.error',
  'wyoming.policy.violation',
  'wyoming.audit.summary',
  'system.error',
];

export const MAX_DEBUG_MESSAGE_CHARS = 220;
export const MAX_DEBUG_DETAILS = 6;
