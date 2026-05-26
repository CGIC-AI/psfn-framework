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

The published folder includes `appsettings.json` beside the EXE:

```json
{
  "PsfnVoxtaRelay": {
    "ListenUrl": "http://127.0.0.1:8789",
    "Remote": "http://purrsephone.local.vega.nyc:8789",
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
