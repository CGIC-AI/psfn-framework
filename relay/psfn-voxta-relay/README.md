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

PowerShell:

```powershell
$env:PSFN_VOXTA_RELAY_LISTEN_URL = "http://127.0.0.1:8789"
$env:PSFN_VOXTA_RELAY_REMOTE_HUB_URL = "http://purrsephone.local.vega.nyc:8789/hub"
$env:PSFN_VOXTA_RELAY_REMOTE_API_BASE_URL = "http://purrsephone.local.vega.nyc:8789"
$env:PSFN_VOXTA_RELAY_AUDIO_FOLDER = "E:\VAM\Custom\Sounds\Voxta"
dotnet run --project relay/psfn-voxta-relay/PsfnVoxtaRelay.csproj
```

Configure the AcidBubbles plugin to `127.0.0.1:8789`.

## Config

| Environment variable | Default |
| --- | --- |
| `PSFN_VOXTA_RELAY_LISTEN_URL` | `http://127.0.0.1:8789` |
| `PSFN_VOXTA_RELAY_REMOTE_HUB_URL` | `http://purrsephone.local.vega.nyc:8789/hub` |
| `PSFN_VOXTA_RELAY_REMOTE_API_BASE_URL` | inferred from remote hub URL |
| `PSFN_VOXTA_RELAY_AUDIO_FOLDER` | temp folder fallback |
| `PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN` | unset |

## Build

```bash
dotnet build relay/psfn-voxta-relay/PsfnVoxtaRelay.csproj
```
