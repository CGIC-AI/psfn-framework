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
    const match = /\[message_id:(\d+)\] (.*?):.*?My project ([a-z0-9]+) has launch phrase ([a-z0-9-]+)\./u.exec(transcript);
    if (!match) return { kind: 'extraction', content: '<response></response>' };
    const [, id, speaker, project, phrase] = match;
    const safeSpeaker = speaker.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
    return { kind: 'extraction', content: `<response><fact><text>${safeSpeaker}'s project ${project} has launch phrase ${phrase}.</text><type>semantic</type><importance>0.9</importance><confidence>0.99</confidence><tags>project,launch</tags><sensitivity>public</sensitivity><retention_class>durable</retention_class><source_message_ids>${id}</source_message_ids><source_speaker_name>${safeSpeaker}</source_speaker_name><subject_name>${safeSpeaker}</subject_name><address_mode>system_api</address_mode></fact></response>` };
  }
  // Only the current human message selects fault injection. Historical failure
  // markers must not poison the next recovery request.
  if (current.includes('SMOKE_PROVIDER_FAILURE')) return { kind: 'failure', status: 400 };
  if (current.includes('SMOKE_PROVIDER_HOLD')) return { kind: 'hold', delayMs: 60_000 };
  const recall = /What is the launch phrase for my project ([a-z0-9]+)\?/u.exec(current);
  if (recall) {
    // Restrict to the system prompt: the fresh-session request carries no answer.
    const evidence = new RegExp(`project ${recall[1]} has launch phrase ([a-z0-9-]+)\\.`, 'u').exec(system);
    return { kind: 'recall', content: evidence ? evidence[1] : 'NO_RETRIEVED_LAUNCH_PHRASE' };
  }
  if (current.includes('My project ') && current.includes(' has launch phrase ')) {
    return { kind: 'memorize', content: 'I have noted your project launch phrase.' };
  }
  return null;
}
