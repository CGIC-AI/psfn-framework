---
name: music-creator
description: Design guidance for future music workflows; the current runtime has no canonical music-generation tool.
category: creator
always: false
---
# Music Creator

Use this skill for music prompt craft or workflow design only when the runtime
explicitly advertises a music-capable tool. The current default runtime does
not expose one.

Creator skills sit above execution tools:
- Never call the retired `media` alias or repurpose the image-only
  `generate_image` tool for audio.
- Load this skill with `skill action="view"` when you need composition guidance, arrangement constraints, lyric structure guidance, or backend-specific notes.
- Follow the same pattern for future creator domains. Add or load a creator skill instead of inventing a new top-level tool.

## Action Selection
- Use only the exact music tool and actions present in the current structured
  tool catalog.
- If no music-capable tool is present, help design the brief or explain that
  execution is unavailable; do not invent a call.
- Keep future generation, edit/remix, and analysis actions on one declared
  music surface unless the runtime contract deliberately separates them.

## Prompt Craft
- Specify genre, instrumentation, tempo or energy, structure, mood, era, and production texture as one coherent brief.
- State whether vocals are wanted, who they are for, and any lyrical constraints such as point of view, explicit phrases to include, or phrases to avoid.
- For edits, define what must remain stable: melody, rhythm, voice, hook, arrangement, or duration.
- Prefer a short decisive brief over a pile of genre tags.

## Provider And Model Notes
- Stay on provider/model auto unless the Partner or Participant asks for a specific backend or the workflow clearly needs one.
- Backend-specific knobs, model IDs, duration constraints, or stem-layout quirks belong here rather than in the top-level tool description.
- When music support lands, update this skill against the exact registered
  surface before describing it as callable.

## Review Loop
- Inspect the returned artifact or analysis before asking broad quality questions.
- Iterate by tightening the brief, arrangement constraints, or edit target.
