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
.\PsfnVoxtaRelay.exe `
  --remote http://purrsephone.local.vega.nyc:8789 `
  --audio-folder "E:\VAM\Custom\Sounds\Voxta"
```

Configure the AcidBubbles plugin to `127.0.0.1:8789`.

From source:

```powershell
dotnet run --project relay/psfn-voxta-relay/PsfnVoxtaRelay.csproj -- `
  --remote http://purrsephone.local.vega.nyc:8789 `
  --audio-folder "E:\VAM\Custom\Sounds\Voxta"
```

## Config

| CLI option | Environment variable | Default |
| --- | --- | --- |
| `--listen` | `PSFN_VOXTA_RELAY_LISTEN_URL` | `http://127.0.0.1:8789` |
| `--remote-hub` | `PSFN_VOXTA_RELAY_REMOTE_HUB_URL` | `http://purrsephone.local.vega.nyc:8789/hub` |
| `--api` | `PSFN_VOXTA_RELAY_REMOTE_API_BASE_URL` | inferred from remote hub URL |
| `--audio-folder` | `PSFN_VOXTA_RELAY_AUDIO_FOLDER` | temp folder fallback |
| `--token` | `PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN` | unset |

`--remote <url>` is a shortcut for `--remote-hub <url>/hub` and `--api <url>`.

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
