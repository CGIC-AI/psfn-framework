import { describe, expect, it } from 'vitest';
import { classifyToolResultCogSecProvenance } from './tool-result-provenance.js';

describe('structural tool-result CogSec provenance', () => {
  it('recognizes only the explicitly registered internal tool surfaces', () => {
    expect(classifyToolResultCogSecProvenance('memory')).toBe('own_memory_read');
    expect(classifyToolResultCogSecProvenance('beads.show')).toBe('local_database_read');
    expect(classifyToolResultCogSecProvenance('journal')).toBe('journal');
    expect(classifyToolResultCogSecProvenance('fs.search')).toBe('local_fs_read');
    expect(classifyToolResultCogSecProvenance('shell.exec')).toBe('self_directed_shell');
    expect(classifyToolResultCogSecProvenance('tool_search')).toBe('local_database_read');
    expect(classifyToolResultCogSecProvenance('toolset')).toBe('local_database_read');
  });

  it('keeps web, MCP, and unknown tool results external', () => {
    expect(classifyToolResultCogSecProvenance('web.fetch')).toBe('external');
    expect(classifyToolResultCogSecProvenance('mcp.call')).toBe('external');
    expect(classifyToolResultCogSecProvenance('not-registered')).toBe('external');
  });
});
