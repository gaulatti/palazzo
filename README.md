# Palazzo

Self-hosted internet radio station controller — REST API to push songs, jingles, and live audio into a Liquidsoap/Icecast stream.

Single Docker container: NestJS + Liquidsoap + Icecast2.

## Quick Start

```bash
cp .env.example .env
mkdir -p secrets
openssl rand -hex 32 > secrets/palazzo-control-token
docker network create broadcast-control 2>/dev/null || true
docker compose up -d
```

API: `http://localhost:3100` — Stream: `http://localhost:8000/stream`

## API

Push a song: `POST /song` with `{"url": "https://...mp3"}`

All endpoints at a glance:

| Method | Path                                       | Description                                               |
| ------ | ------------------------------------------ | --------------------------------------------------------- |
| `GET`  | `/status`                                  | Stream health and metadata                                |
| `GET`  | `/playback/state`                          | Authoritative current playback snapshot                   |
| `GET`  | `/playback/events`                         | Replay-safe Server-Sent Events                            |
| `GET`  | `/metrics`                                 | Authenticated Prometheus telemetry                        |
| `GET`  | `/v1/programs/:programId/automation`       | Authenticated automation lifecycle state                  |
| `POST` | `/v1/programs/:programId/automation/start` | Start the program automation without restarting transport |
| `POST` | `/v1/programs/:programId/automation/stop`  | Clear program material while preserving the Icecast mount |
| `POST` | `/song`                                    | Push a song, skips current                                |
| `POST` | `/song/stop`                               | Skip current song                                         |
| `POST` | `/instant`                                 | Push a jingle/SFX                                         |
| `POST` | `/instant/stop`                            | Stop all instants                                         |
| `GET`  | `/mixer`                                   | Read the applied song, instant, and main mixer state      |
| `PUT`  | `/mixer`                                   | Apply song, instant, and main volume/mute controls        |
| `GET`  | `/proxy-audio?url=`                        | CORS proxy for audio URLs                                 |

`POST /song` and `POST /instant` accept an optional caller-supplied
`playbackRequestId`, generating one when omitted. Song metadata and that ID
travel with the Liquidsoap request and reappear in lifecycle,
position, and state telemetry. Level samples are emitted at no more than 10 Hz,
position at 1 Hz, and heartbeats approximately every 10 seconds.

The control API, SSE feed, metrics, and unauthenticated Liquidsoap command
socket are private interfaces. `/metrics` requires the same mounted bearer
token as lifecycle control. The provided Compose and deployment mappings bind
the API to host loopback and join the private `broadcast-control` network;
publish only Icecast (or route it through a reverse proxy) for listeners.

Palazzo boots in `reconciliation-required`: container or process startup never
pretends a prior operator Start/Stop succeeded. Alcantara reconciles it through
the authenticated lifecycle API. Start becomes ready only when Liquidsoap, its
control/telemetry connection, and the Icecast source output are healthy. Stop
flushes both queues and waits for authoritative idle while leaving Liquidsoap
and the 24x7 Icecast mount connected. See
[docs/broadcast-lifecycle.md](docs/broadcast-lifecycle.md).

Full details: [API Reference](wiki/API-Reference)

Telemetry operations and migration guidance:
[docs/playback-telemetry.md](docs/playback-telemetry.md).

## Documentation

- [Architecture](wiki/Architecture) — System design, data flow, Liquidsoap engine
- [API Reference](wiki/API-Reference) — All endpoints with request/response schemas
- [Configuration](wiki/Configuration) — Environment variables and settings
- [Deployment](wiki/Deployment) — Docker, Compose, CI/CD
- [Development](wiki/Development) — Local setup and project structure

## License

MIT
