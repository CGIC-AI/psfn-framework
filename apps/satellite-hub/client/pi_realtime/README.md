# Pi Realtime Client

This is the top-tier device client for Pi-class hardware.

It is not an ESPHome voice satellite. It keeps one websocket open to the hub, owns local microphone capture, owns local playback, and can interrupt playback immediately on local speech.

## What It Needs

- a running hub with `DEVICE_TRANSPORT=realtime` or `DEVICE_TRANSPORT=hybrid`
- the Pi-side Python environment used by `linux-voice-assistant`
- `websockets` installed into that venv
- working PipeWire or PulseAudio defaults for mic and speaker

## Deploy

From the repo root:

```bash
PI_USER=<pi-user> PI_PASSWORD='<pi-password>' HUB_WS_URL=ws://<hub-host>:8787/ DEVICE_ID=<device-id> DEVICE_NAME=<device-name> ./scripts/deploy-pi-realtime-client.sh <pi-host>
```

That script:

- copies `client/pi_realtime/client.py` to the Pi
- installs `websockets` into the existing Pi venv
- writes `/etc/psfn-realtime-client.env`
- installs `psfn-realtime-client.service`
- disables `linux-voice-assistant.service`
- enables the realtime client service

## Runtime Contract

The client speaks the websocket protocol documented in `docs/realtime-client-protocol.md`.

Key behaviors:

- local preroll buffer so interrupt speech is not dropped
- local playback kill before sending `interrupt`
- local VAD drives `turn.start`, `audio`, and `turn.end`
- streamed assistant audio is played locally through `ffplay`
