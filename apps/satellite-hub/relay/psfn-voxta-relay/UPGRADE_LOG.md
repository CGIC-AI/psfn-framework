# Relay dependency upgrade log

Date: 2026-10-23. Project: PsfnVoxtaRelay, C# / .NET 8.
Tracked work: psfn-framework-zbbxj.10.

## Microsoft.AspNetCore.SignalR.Client 8.0.26 → 8.0.32

One direct dependency updated; NAudio 2.2.1 remains unchanged. No target-framework,
preview-package, application API or advisory-suppression change.

The baseline online NuGet scan reports High-severity
[GHSA-334f-vvp4-7g6p / CVE-2026-70159](https://github.com/dotnet/aspnetcore/security/advisories/GHSA-334f-vvp4-7g6p)
in SignalR.Common 8.0.26. Microsoft lists 8.0.0–8.0.31 as affected and 8.0.32
as fixed. The issue permits stateful reconnect backpressure to retain resources
and block broadcasts indefinitely.

[Microsoft's stable 8.0.32 release](https://github.com/dotnet/aspnetcore/releases/tag/v8.0.32)
was published on October 13, 2026.
[NuGet's 8.0.32 package](https://www.nuget.org/packages/Microsoft.AspNetCore.SignalR.Client/8.0.32)
targets net8.0. Validation uses SDK 8.0.132 and runtime/ASP.NET Core 8.0.32.
The version is exact (`[8.0.32]`); ordinary restores are locked.

Official source inspected: dotnet/aspnetcore
[`7413d24330774263a78a4f3837ca53493518455a`](https://github.com/dotnet/aspnetcore/tree/7413d24330774263a78a4f3837ca53493518455a),
stable tag v8.0.32, compared with v8.0.26. The C# client source directory and
SignalR public API files have no changes. The shared
[MessageBuffer replay implementation](https://github.com/dotnet/aspnetcore/blob/7413d24330774263a78a4f3837ca53493518455a/src/SignalR/common/Shared/MessageBuffer.cs#L268)
adds cancellation and abort handling for stalled replay. No relay call-site
migration was required.

| net8.0 package group | Before | After |
| --- | --- | --- |
| SignalR.Client; Client.Core; Common; Protocols.Json | 8.0.26 | 8.0.32 |
| Connections.Abstractions; Http.Connections.Client; Common | 8.0.26 | 8.0.32 |
| Microsoft.Extensions.Features | 8.0.26 | 8.0.32 |
| NAudio and other transitive dependencies | unchanged | unchanged |
| SDK single-file analyzer tool | implicit at publish | ILLink.Tasks 8.0.32 locked |

Both executable projects commit `packages.lock.json`, including resolved versions
and content hashes. [NuGet's lock-file guidance](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#locking-dependencies)
explains that a referenced project's lock does not lock its consuming project's
graph, so the harness has its own lock. A future intentional upgrade regenerates
these files with `--force-evaluate -p:RestoreLockedMode=false`, followed by locked
restore and review. Do not use that override in ordinary builds.

The relay explicitly includes the documented Windows x64 publish and Linux x64
validation runtime identifiers. This keeps a self-contained Windows publish in
the locked graph; adding a runtime identifier only at publish time otherwise
fails NuGet's locked restore with NU1004.
The single-file analyzer is enabled for ordinary builds too, so the SDK's
implicit Microsoft.NET.ILLink.Tasks 8.0.32 dependency is locked rather than added
only when publishing. This enables analysis; it does not enable trimming.

## Validation

Commands below run from the repository root; `relay` denotes
`apps/satellite-hub/relay/psfn-voxta-relay/PsfnVoxtaRelay.csproj`, and `harness`
denotes `apps/satellite-hub/relay/psfn-voxta-relay.tests/PsfnVoxtaRelay.Tests.csproj`.

| Check | Command |
| --- | --- |
| Locked graph | `dotnet restore <relay-or-harness> --locked-mode` |
| Build | `dotnet build <relay-or-harness> --no-restore --nologo` |
| Static checks | `dotnet format <relay-or-harness> --verify-no-changes --no-restore` |
| Logger and artifact regressions | `dotnet run --project <harness> --no-restore --nologo` |
| Actual process/auth/privacy tests | `node --test apps/satellite-hub/relay/auth.test.mjs apps/satellite-hub/relay/privacy.test.mjs` |
| Online advisory scan | `dotnet list <relay-or-harness> package --vulnerable --include-transitive` |

Both locked restores, both builds and both format checks passed. Builds produced
zero warnings/errors. The real logger/artifact harness and all five actual relay
auth/privacy process tests passed. Online NuGet scans report no vulnerable
packages for either project, including transitive dependencies.
Locked win-x64 restore and Release self-contained single-file publishing also
passed from the Linux build host; the Windows executable was not run here.

The repository's digest-pinned OSV-Scanner 2.4.0 wrapper also passed with these
two lockfiles supplied explicitly: 33 package entries in the relay graph and 27
in the harness graph, with only the local project-reference entry unscannable.
No advisory suppressions were used. Default shared-wrapper coverage is delivered
separately by psfn-framework-zbbxj.9 and requires integrated validation.

Self-contained releases must be rebuilt and redeployed to carry serviced
assemblies; updating source or a package cache does not update an already
published executable. Windows microphone/device and filesystem runtime behavior
remain outside Linux-only validation. Shared OSV-wrapper integration is owned
by psfn-framework-zbbxj.9 and must include both committed NuGet lockfiles.
