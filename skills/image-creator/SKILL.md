---
name: image-creator
description: Creator-skill guidance for image workflows on top of the unified media surface.
category: creator
always: false
---
# Image Creator

Use this skill when an image workflow needs more than the generic `media` surface.

Creator skills sit above execution tools:
- Keep execution on `media`.
- Load this skill with `skill action="view"` when you need workflow-specific prompt craft, composition guidance, continuity rules, or provider quirks.
- Treat the same pattern as reusable for other creator domains such as music or future media workflows. Add or load another creator skill instead of inventing a new top-level tool.

## Action Selection
- Use `media action="generate"` for a brand-new image or image set.
- Use `media action="edit"` when you already have one or more source URLs and want to transform them.
- Use `media action="analyze"` to inspect generated output, a remote image URL, or a user-provided image when the runtime tells you to analyze instead of directly inspecting attachments.
- Do not ask for a separate image-generation tool. Image creation remains a skill-guided workflow on the shared `media` surface.

## Prompt Craft
- Treat the prompt as the target result, not a vague theme.
- For companion self-images, combine the runtime Appearance context with shot type, framing, pose, camera angle, lighting, background, mood, and styling cues.
- For non-self images, define subject, composition, environment, style, and output constraints as one coherent brief.
- For edits, say what must change and what must stay locked. Identity continuity belongs in the instruction when it matters.
- Prefer one coherent aesthetic direction over a bag of disconnected adjectives.

## Provider And Model Notes
- Stay on provider/model auto unless the user asks for a specific backend or the workflow clearly needs one.
- Advanced flags such as `guidance_scale`, `negative_prompt`, `input_fidelity`, `use_turbo`, or explicit `model` overrides are deliberate exceptions, not defaults.
- FAL model IDs, ComfyUI workflow quirks, and other backend-specific habits belong here rather than in the top-level tool description.
- If the media backend expands, keep backend-specific detail in this skill or a sibling creator skill rather than widening the model-facing tool taxonomy.

## Review Loop
- Generate and edit actions already return a vision review. Use that first before asking the user whether the result basically worked.
- Use `media action="analyze"` when you need a fresh inspection of a specific remote URL or a focused answer to a visual question.
- Iterate by revising the prompt or edit instruction, not by switching tools.
