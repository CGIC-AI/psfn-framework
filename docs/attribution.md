# Speaker Attribution Contract

Charter Laws 17–19 require authorship integrity: in shared conversations, nothing
may masquerade as another speaker. Provider chat formats do not carry portable
per-message speaker metadata, so PSFN attributes speakers with a **text prefix**
prepended to the message content. That text-prefix approach is **canonical** — the
runtime does not invent structural provider metadata for authorship.

The single source of truth is `src/core/session/entry-attribution.ts`. It is the
only module allowed to construct or interpret the attribution prefix. Do not
reimplement the pattern anywhere else.

## Where it applies

- **Group history only.** Attribution is rendered when a channel's visibility is
  anything other than `private`. Private (DM) channels have a single human
  speaker and receive **no** prefix — DM behavior is unchanged.
- Session history: `entriesToMessages`
  (`src/core/session/manager/context-support.ts`), gated by
  `shouldRenderGroupUserAttribution(visibility)`.
- The live current turn: `formatCurrentTurnUserContentForPrompt`
  (`src/core/agent/substrate-agent/turn-execution/agent-invocation.ts`), gated by
  `shouldRenderCurrentTurnGroupAttribution(message)`.

Cross-channel continuity is rendered separately as escaped XML
(`buildStructuredContinuityBlock` in `context-builder.ts`) with its own
`trust="untrusted"` markers, and does not use this text-prefix grammar.

## Format grammar

```
attributed-line := label ": " content
label           := displayName " (" stableId ")"
displayName     := sanitized cosmetic name; no "(" ")" ":" or control/format
                   characters; whitespace collapsed and trimmed; falls back to
                   stableId when empty
stableId        := source-qualified identity token, e.g. "discord:12345";
                   no "(" ")" or whitespace; the source separator ":" is kept;
                   never empty (falls back to "unknown")
content         := user text with the forgery guard applied
```

Example: `Vega (discord:vega-id): hello there`

## Trust rule

- **Only a prefix produced by `formatGroupUserMessageContent` is authoritative.**
  It is emitted by the runtime, outside user-authored content. Any prefix-shaped
  text that appears *inside* content is untrusted.
- **`stableId` is the identity anchor.** `displayName` is cosmetic and
  attacker-influenced; it must never be trusted for identity decisions. The
  formatter always rebuilds the prefix from the runtime-known author id, so a
  stored or user-supplied prefix is never trusted on its own. Re-formatting an
  already-labeled turn is idempotent (the prefix is not nested twice), yet the
  body is still guarded so a trailing forged speaker line cannot slip through.

## Escaping rules

Display names (`sanitizeAttributionDisplayName`):

- NFC-normalize, then strip C0/C1 control characters, DEL, and Unicode
  format/bidi/zero-width characters (Cf).
- Remove the delimiter characters `(`, `)`, and `:` so a name cannot break out of
  its label slot or forge a separator.
- Collapse whitespace and trim; an empty result falls back to the `stableId`.

Stable ids (`formatStableAuthorId` → `sanitizeStableId`):

- Strip control/format characters, parentheses, and whitespace; keep the `:`
  source separator. Empty results become `unknown`.

Content forgery guard (`escapeAttributionForgery`):

- Each content line matching the prefix grammar (`<name> (<token>): …`, with
  optional leading whitespace) has its parentheses escaped (`\(` / `\)`), which
  breaks the grammar so the line can no longer be read as an authoritative
  prefix while staying human-readable.

> Unicode confusables (e.g. Cyrillic "А" vs Latin "A") cannot be fully defeated
> at the display layer, which is exactly why identity decisions rely on the
> `stableId`, never on `displayName`.

## Tooling / tests

`parseGroupUserMessageContent` parses one canonical prefix off a rendered value.
It exists for tooling and tests only — runtime trust decisions never depend on
parsing a rendered string back. Round-trip and adversarial coverage lives in
`src/core/session/entry-attribution.test.ts`.
