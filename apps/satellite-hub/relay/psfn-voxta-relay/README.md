# PSFN Voxta Relay

Local VaM compatibility relay for the AcidBubbles Voxta plugin.

The VaM plugin points at one local endpoint. This relay exposes that endpoint,
keeps the Voxta SignalR shape VaM expects, and talks to a remote
`psfn-satellite-hub`.

## Responsibilities

- serve local SignalR `/hub` for VaM
- create one remote SignalR `/hub` connection per local VaM client
- rewrite `authenticate` capabilities from VaM `LocalFile` audio to remote `Url`
  audio while preserving the VaM audio folder
- download remote `replyChunk.audioUrl` / `thinkingSpeechUrl` files into the VaM
  audio folder and rewrite those fields to local paths
- forward local `/api/...` REST calls to the remote hub for service toggles and
  vision uploads
- capture Windows microphone audio with NAudio after `recordingRequest` and
  stream 16 kHz mono PCM to the remote hub

The relay intentionally stays JSON-pass-through. It does not depend on
`Voxta.Model.dll`.

## Run

Published executable on the VaM Windows machine:

```powershell
.\PsfnVoxtaRelay.exe
```

Configure the AcidBubbles plugin to `127.0.0.1:8789`.

Configure `PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN` with the Hub's dedicated
`VOXTA_AUTH_TOKEN` (or an enrolled device credential with the required Voxta
capabilities). Keep it outside tracked files and command-line arguments. The
relay sends Authorization headers on SignalR, REST, audio downloads and
microphone upgrades. It refuses non-loopback listeners and foreign browser
Origins; remote HTTP audio URLs must match the configured API origin and
redirects are not followed. Use HTTPS for remote Hub traffic.

The Hub disables Voxta by default. Set `VOXTA_FACADE_ENABLED=true` and rotate
the Hub/relay token together by replacing it and restarting both processes.
See the [Hub migration guide](../../README.md#hub-authentication-and-migration).

Source validation (explicit .NET opt-in), from the repository root:

```bash
npm --prefix apps/satellite-hub run build:ts
dotnet build apps/satellite-hub/relay/psfn-voxta-relay/PsfnVoxtaRelay.csproj --nologo --verbosity quiet
dotnet run --project apps/satellite-hub/relay/psfn-voxta-relay.tests/PsfnVoxtaRelay.Tests.csproj --nologo
node --test apps/satellite-hub/relay/auth.test.mjs apps/satellite-hub/relay/privacy.test.mjs
```

The socket test runs the actual Hub and relay and checks authenticated REST,
SignalR turns, audio downloads, Origin rejection, and wildcard-bind rejection.

The published folder includes `appsettings.json` beside the EXE:

```json
{
  "PsfnVoxtaRelay": {
    "ListenUrl": "http://127.0.0.1:8789",
    "Remote": "http://companion.example.com:8789",
    "AudioFolder": "E:\\VAM\\Custom\\Sounds\\Voxta",
    "RemoteBearerToken": ""
  }
}
```

From source:

```powershell
dotnet run --project relay/psfn-voxta-relay/PsfnVoxtaRelay.csproj -- `
  --config relay/psfn-voxta-relay/appsettings.json
```

## Config

| CLI option | Config key | Environment variable | Default |
| --- | --- | --- | --- |
| `--config` | n/a | `PSFN_VOXTA_RELAY_CONFIG` | `appsettings.json` next to the EXE |
| `--remote` | `Remote` | `PSFN_VOXTA_RELAY_REMOTE_URL` | required unless `RemoteHubUrl` is set |
| `--listen` | `ListenUrl` | `PSFN_VOXTA_RELAY_LISTEN_URL` | `http://127.0.0.1:8789` |
| `--remote-hub` | `RemoteHubUrl` | `PSFN_VOXTA_RELAY_REMOTE_HUB_URL` | inferred from `Remote` |
| `--api` | `RemoteApiBaseUrl` | `PSFN_VOXTA_RELAY_REMOTE_API_BASE_URL` | inferred from remote hub URL |
| `--audio-folder` | `AudioFolder` | `PSFN_VOXTA_RELAY_AUDIO_FOLDER` | temp folder fallback |
| `--token` | `RemoteBearerToken` | `PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN` | unset |

`--remote <url>` is a shortcut for `--remote-hub <url>/hub` and `--api <url>`.
Precedence is CLI, then environment, then `appsettings.json`.

`AudioFolder` is the approved local artifact root. Set it to the VaM plugin's
audio directory before connecting. The plugin can select that directory or a
subdirectory beneath it; outside paths, symlinked directories and Windows
reparse points are rejected. Local/file audio sources are also limited to
regular, singly linked WAV/MP3 files beneath this root. Remote HTTP(S) audio
still requires the configured upstream API origin and cannot redirect.

Audio transfers have a 32 MiB limit and a 30-second total deadline, including
response headers and streaming. A private temporary file is flushed and
atomically renamed only after the complete transfer succeeds. Existing linked
or non-regular destinations are refused. Failed transfers remove their temporary
file and do not replace a previous playable file or forward the rejected URL.

Relay-owned `psfn_<24-or-32-hex-digits>.wav`, `.mp3` and `.partial` artifacts
expire after 24 hours. Cleanup runs at startup, every 15 minutes and before a
download in the selected folder. It leaves fresh files, client-owned names and
unsafe links alone. Root directories and selected subdirectories use Unix 0700;
new audio and temporary files use 0600. On Windows, protected owner-only DACLs
provide the corresponding access restriction. The root must belong to the
current account and reside on a filesystem supporting these protections.

Linux x64/arm64 uses ABI-specific no-follow, descriptor-relative file operations
and checks link counts; other Linux ABIs are rejected.
Windows pins ancestor directories against rename, opens reparse points without
following them, checks regular disk-file/link-count metadata, and renames by
handle. Unsupported platforms or filesystems fail closed. Windows integration
tests require permission to create symbolic links; Linux validation does not
certify Windows hardware or filesystem behavior.

Config reads are bounded to 1 MiB and reject linked or non-regular files without
changing the operator file's contents, permissions or modification time. Logs
contain fixed JSON event names, numeric fields and fresh correlation IDs;
paths, URLs, tokens, transcripts, replies and raw exception text are excluded.

Microphone callbacks synchronously copy into one owned send queue. Its hard
limits are 16 chunks, 960 bytes per chunk and 15,360 bytes total, including the
active send (at most 480 ms of PCM). A full queue or oversized callback stops the
recording; audio is never dropped while recording continues. Connect, format
header and PCM sends each have a five-second deadline. Overflow, timeout and
transport failure emit fixed event names and cancel the stream. A subsequent
recording request creates a fresh stream.

Shutdown stops capture, cancels and aborts the socket, then gives the active
operation two seconds to drain. Queue and active audio contents are cleared;
repeated/concurrent disposal shares one pump completion. The socket is disposed
only after its active operation exits. If an injected or faulty transport ignores
both cancellation and abort, the pump still terminates at the drain deadline and
defers disposal of that single transport operation until it exits, retaining only
cleared audio. This case emits `microphone.shutdown_timed_out`.

## Build

```bash
dotnet build relay/psfn-voxta-relay/PsfnVoxtaRelay.csproj
```

## Publish Windows EXE

```bash
dotnet publish relay/psfn-voxta-relay/PsfnVoxtaRelay.csproj \
  -c Release \
  -r win-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -p:PublishTrimmed=false \
  -o .artifacts/psfn-voxta-relay-win-x64
```
