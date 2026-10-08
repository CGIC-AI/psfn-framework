import { describe, expect, it } from 'vitest';
import { runRLMLoop } from '../../core/tools/analysis-workbench/loop.js';
import { DEFAULT_REPL_CONFIG } from '../../core/tools/analysis-workbench/types.js';
import { createScriptedE2ELLMProvider } from './test-llm-provider.js';

// Exercise the same model fixture used by the composition harness through the
// actual sandbox child process, rather than asserting its canned source text.
describe('composition harness evidence', () => {
  it('cannot answer a memory question from its keyword or earlier transcript', async () => {
    const model = createScriptedE2ELLMProvider();
    const messages = [
      { role: 'user' as const, content: "The Partner's favorite dessert is tiramisu." },
      { role: 'user' as const, content: "What is the Partner's favorite dessert?" },
    ];
    const absent = await model.stream({ systemPrompt: 'You are a companion.', messages });
    expect(absent.content).not.toContain('tiramisu');
    const supplied = await model.stream({
      systemPrompt: "Relevant memory: the Partner's favorite dessert is plum crumble.",
      messages,
    });
    expect(supplied.content).toContain('plum crumble');
    expect(supplied.content).not.toContain('tiramisu');
  });

  it('does not extract fixture facts absent from its input', async () => {
    const response = await createScriptedE2ELLMProvider().complete({
      systemPrompt: 'Extract facts from the supplied conversation.',
      messages: [{ role: 'user', content: 'Good morning.' }],
    }, 'extraction');
    expect(response.content).not.toContain('<fact>');
    expect(response.content).not.toContain('tiramisu');
  });

  it('computes arithmetic inside the production sandbox instead of returning a canned FINAL', async () => {
    const result = await runRLMLoop('Calculate 17 * 23 using the code sandbox. Return the result.', {
      llmProvider: createScriptedE2ELLMProvider(),
      embeddingService: null,
      memoryStore: null,
      sessionManager: null,
      config: DEFAULT_REPL_CONFIG,
    });
    expect(result.answer).toBe('391');
    expect(result.steps.some(step => step.code.trim().length > 0 && step.error === null)).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('does not manufacture search results when no memory store is available', async () => {
    const result = await runRLMLoop('How many memories mention the Partner? Return a count and brief summary.', {
      llmProvider: createScriptedE2ELLMProvider(),
      embeddingService: null,
      memoryStore: null,
      sessionManager: null,
      config: DEFAULT_REPL_CONFIG,
    });
    expect(result.answer).toBe('[]');
    expect(result.steps).toContainEqual(expect.objectContaining({ code: expect.stringContaining('memory_search('), error: null }));
    expect(result.answer).not.toContain('tiramisu');
  });
});
