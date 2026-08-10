# Monorepo Import Provenance

`CGIC-AI/psfn-framework` is the canonical repository for the framework,
Satellite Hub, companion applications, and eval tooling. Changes to imported
code land here; the predecessor repositories are historical sources.

## Imported histories

| Component | Current path | Source repository | Imported source head | Import commit |
| --- | --- | --- | --- | --- |
| Satellite Hub | `apps/satellite-hub` | `CGIC-AI/psfn-satellite-hub` | `6aa49aadb7536eec88c85573986d1af6102ab5f4` | `aa6043ae16eca281b542c4536c089ef6199ed78d` |
| Eval toolkit | `tools/evals` | `CGIC-AI/psfn-eval-toolkit` | `a6e540ad77b48ef1801d361d241f01d5f218098f` | `64296d9058bb8f4c855081ff0dbcf6f8037f0f9d` |

Both imports used unsquashed subtree merges. The source heads are direct parents
of the import commits, so predecessor commits remain addressable and traceable:

```bash
git merge-base --is-ancestor 6aa49aadb7536eec88c85573986d1af6102ab5f4 aa6043ae16eca281b542c4536c089ef6199ed78d
git merge-base --is-ancestor a6e540ad77b48ef1801d361d241f01d5f218098f 64296d9058bb8f4c855081ff0dbcf6f8037f0f9d
git log --follow -- apps/satellite-hub/src/ts/hub/main.ts
git log --follow -- tools/evals/eval/src/validation.ts
```

The commit-identity gate exempts only commits in the ancestry of these two exact
source heads. Their original identities remain intact, while all descendants and
new framework commits continue to require the framework identity allowlist.

The current tree contains ordinary files, not submodules or nested repositories.
The eval toolkit's unused `vendor/emosim` gitlink and both projects' nested agent
configuration were removed after import. Their original state remains available
from the source commits above.

## Tracker migration

Record Hub and eval work with `bd` from the repository root. For provenance,
inspect the Hub source tracker at:

```bash
git show 6aa49aadb7536eec88c85573986d1af6102ab5f4:.beads/issues.jsonl
```

Open source items were migrated with an `external_ref` back to that exact file:

| Source bead | Root bead |
| --- | --- |
| `PSFNLIVE-7f0` | `psfn-framework-jaw48` |
| `PSFNLIVE-hq5` | `psfn-framework-e25n3` |
| `opanhome-0eh` | `psfn-framework-jraj4` |
| `opanhome-g0h` | `psfn-framework-lnm3m` |
| `opanhome-nvg` | `psfn-framework-ujpug` |
| `opanhome-1rh` | `psfn-framework-o3brd` |
| `opanhome-clm.3` | `psfn-framework-ib781` |
| `opanhome-clm` | `psfn-framework-scju5` |
| `PSFNLIVE-ajf` | `psfn-framework-ptuor` |
| `PSFNLIVE-e25` | `psfn-framework-gagi5` |
| `PSFNLIVE-e3o.4` | `psfn-framework-u03g5` |
| `PSFNLIVE-e3o.5` | `psfn-framework-3cock` |
| `PSFNLIVE-e3o.2` | `psfn-framework-xui2y` |
| `PSFNLIVE-e3o.3` | `psfn-framework-96zbv` |
| `PSFNLIVE-e3o` | `psfn-framework-n6a50` |
| `PSFNLIVE-e3o.1` | `psfn-framework-z0cu5` |
| `opanhome-clm.4` | `psfn-framework-pae5p` |
| `opanhome-clm.2` | `psfn-framework-52idh` |

The source parent/child and blocking edges for the two open epics were recreated
in the root tracker. New Hub and eval work must use root Beads; do not reactivate
the nested tracker export.

## Package boundaries

- `apps/satellite-hub` owns voice/device transport, embodiment bridges,
  firmware sources, Device Studio, and the optional .NET relay.
- `tools/evals` owns bounded offline evals and explicit provider/model probes.
- Framework production images exclude both imported dependency trees. The Hub
  has its own commit-labeled non-root image.
- `mise.toml` delegates reproducible package checks. Firmware, hardware,
  live-provider, spending, model-download, and .NET tasks remain opt-in.
