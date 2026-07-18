# Disposable support companions

These fixtures give Artie two real peer processes for local multi-companion
shakedown cases. Mica and Lumen are synthetic, non-private identities with no
channel accounts. The canonical fleet contract is `companions.template.json`;
the cards under `cards/` are supported JSON character-card imports.

The round must already have Artie's card and the `shakedown_artie` PostgreSQL
tenant boundary. Stop the split runtime, source the round env, explicitly set
`PSFN_MULTI_COMPANION=1`, and run:

```bash
npm run shakedown:support -- stand-up
```

Stand-up verifies the database has no other runtime sessions, preserves Artie's
card and tenant, imports the two support cards beneath
`$PSFN_RUNTIME_ROOT/support-companions`, provisions their isolated tenant
schemas, and publishes `$SYSTEM_DATA_DIR/companions.json`. Starting
`npm run split` after that manifest is published launches one agent (and one
Garden port) per entry through the existing supervisor.

After the ICP, fatigue-closeout, and crossover-isolation cases, stop the split
runtime and run:

```bash
npm run shakedown:support -- tear-down
```

Teardown is fail-closed. It requires the exact state record and manifest digest
created by stand-up, refuses active database sessions or foreign role
ownership, drops only the two support tenant schemas and roles, verifies they
are absent, and removes the support cards, manifest, and state record. Artie's
card and `shakedown_artie` tenant remain.
