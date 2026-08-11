---
name: music-creator
description: Creator-skill guidance for music workflows on top of the unified media surface.
category: creator
always: false
---
# Music Creator

Use this skill when a music workflow needs domain-specific guidance beyond the current `generate_image` surface.

Creator skills sit above execution tools:
- Keep execution on canonical tools exposed by the runtime; do not invent a generic media tool.
- Load this skill with `skill action="view"` when you need composition guidance, arrangement constraints, lyric structure guidance, or backend-specific notes.
- Follow the same pattern for future creator domains. Add or load a creator skill instead of inventing a new top-level tool.

## Action Selection
- Use the canonical generation action exposed by a future music-capable tool for a new piece, stem set, loop, or song draft.
- Use that tool's canonical edit action for remixing, continuation, or restyling.
- Use that tool's canonical analysis action to inspect the contents or structure of a produced artifact.
- If the current runtime is image-backed only, treat this skill as the pattern contract for upcoming media backends rather than forcing a fake tool call.

## Prompt Craft
- Specify genre, instrumentation, tempo or energy, structure, mood, era, and production texture as one coherent brief.
- State whether vocals are wanted, who they are for, and any lyrical constraints such as point of view, explicit phrases to include, or phrases to avoid.
- For edits, define what must remain stable: melody, rhythm, voice, hook, arrangement, or duration.
- Prefer a short decisive brief over a pile of genre tags.

## Provider And Model Notes
- Stay on provider/model auto unless the user asks for a specific backend or the workflow clearly needs one.
- Backend-specific knobs, model IDs, duration constraints, or stem-layout quirks belong here rather than in the top-level tool description.
- If music support lands through the shared media surface, update this skill rather than adding a parallel top-level music tool.

## Review Loop
- Inspect the returned artifact or analysis before asking broad quality questions.
- Iterate by tightening the brief, arrangement constraints, or edit target.
