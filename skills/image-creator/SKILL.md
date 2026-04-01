---
name: image-creator
description: Prompt craft and provider guidance for image workflows on the unified media tool.
category: creator
always: false
---
# Image Creator

Use this skill when working with `media` for image generation, editing, or review.

## Action Selection
- Use `media action="generate"` for a brand-new image.
- Use `media action="edit"` when you already have one or more source URLs and want to transform them.
- Use `media action="analyze"` to inspect generated output, a remote image URL, or a user-provided image when the runtime tells you to analyze instead of directly inspecting attachments.

## Prompt Craft
- Treat the prompt as the target result, not a vague theme.
- For companion self-images, combine the runtime Appearance context with shot type, framing, pose, camera angle, lighting, background, mood, and styling cues.
- For edits, say what must change and what must stay locked. Identity continuity belongs in the instruction when it matters.
- Prefer one coherent aesthetic direction over a bag of disconnected adjectives.

## Provider And Model Notes
- Stay on provider/model auto unless the user asks for a specific backend or the workflow clearly needs one.
- Advanced flags such as `guidance_scale`, `negative_prompt`, `input_fidelity`, `use_turbo`, or explicit `model` overrides are deliberate exceptions, not defaults.
- FAL model IDs, ComfyUI workflow quirks, and other backend-specific habits belong here rather than in the top-level tool description.

## Review Loop
- Generate and edit actions already return a vision review. Use that first before asking the user whether the result basically worked.
- Use `media action="analyze"` when you need a fresh inspection of a specific remote URL or a focused answer to a visual question.
