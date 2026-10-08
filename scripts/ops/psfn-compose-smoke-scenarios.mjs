import { createHash } from 'node:crypto';

// Deterministic external-provider responses. No runtime state access: recalled
// values must arrive in the provider request through real history/retrieval.
export function textOf(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : '';
}

export function smokeScenario(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const allText = messages.map(message => textOf(message.content)).join('\n');
  const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n');
  const latestUser = [...messages].reverse().find(message => message.role === 'user');
  const current = textOf(latestUser?.content);
  if (/isolated (?:deep-screening )?security classifier|isolated vision screening service/iu.test(system)) return null;
  if (allText.includes('You are analyzing a conversation to extract durable facts')) {
    const transcript = allText.split('Recent conversation:')[1]?.split('Respond with facts')[0] ?? '';
    const match = /\[message_id:(\d+)\] (?:\[[^\]]*\] )*([^\n:]+):.*?My project ([a-z0-9]+) has launch phrase ([a-z0-9-]+)\./u.exec(transcript);
    if (!match) return { kind: 'extraction', content: '<response></response>' };
    const [, id, speaker, project, phrase] = match;
    const safeSpeaker = speaker.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
    return { kind: 'extraction', content: `<response><fact><text>${safeSpeaker}'s project ${project} has launch phrase ${phrase}.</text><type>semantic</type><importance>0.9</importance><confidence>0.99</confidence><tags>project,launch</tags><sensitivity>public</sensitivity><retention_class>durable</retention_class><source_message_ids>${id}</source_message_ids><source_speaker_name>${safeSpeaker}</source_speaker_name><subject_name>${safeSpeaker}</subject_name><address_mode>system_api</address_mode></fact></response>` };
  }
  // Only the current human message selects fault injection. Historical failure
  // markers must not poison the next recovery request.
  const deletion = /SMOKE_DELETE_MEMORY ([a-f0-9-]+)/u.exec(current);
  if (deletion) {
    const last = messages.at(-1);
    if (last?.role === 'tool') return { kind: 'deletion', content: 'The memory deletion proposal awaits operator validation.' };
    if (!body.tools?.some(tool => tool.function?.name === 'memory')) throw new Error('Actual memory tool was not offered');
    return { kind: 'deletion', toolCall: { id: 'call_smoke_delete_' + createHash('sha256').update(current).digest('hex').slice(0, 24), name: 'memory',
      arguments: { action: 'delete', memory_id: deletion[1], justification_category: 'privacy_or_consent',
        explanation: 'Consent withdrawn for this disposable smoke fact.' } } };
  }
  if (current.includes('SMOKE_PROVIDER_FAILURE')) return { kind: 'failure', status: 400 };
  if (current.includes('SMOKE_PROVIDER_HOLD')) return { kind: 'hold', delayMs: 60_000 };
  const recall = /What is the launch phrase for my project ([a-z0-9]+)\?/u.exec(current);
  if (recall) {
    // The oracle only consumes the production retrieval section. History,
    // summaries, persona text and the current question cannot supply an answer.
    const retrieved = [...system.matchAll(/<relevant_memories(?:\s[^>]*)?>([\s\S]*?)<\/relevant_memories>/gu)].map(match => match[1]).join('\n');
    const evidence = new RegExp(`project ${recall[1]} has launch phrase ([a-z0-9-]+)\\.`, 'u').exec(retrieved);
    return { kind: 'recall', content: evidence ? evidence[1] : 'NO_RETRIEVED_LAUNCH_PHRASE' };
  }
  if (current.includes('My project ') && current.includes(' has launch phrase ')) {
    return { kind: 'memorize', content: 'I have noted your project launch phrase.' };
  }
  return null;
}
