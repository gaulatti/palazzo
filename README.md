# Palazzo

Radio streaming orchestration service — manages a Liquidsoap process that
streams audio to an Icecast2 server.

## Overview

Palazzo is a self-hosted internet radio station controller. It runs inside
a single Docker container alongside Liquidsoap and Icecast2, exposing a
REST API you can use to push songs, jingles, and live audio into the stream
from any web UI or automation tool.

```
┌──────────┐   Telnet :14000   ┌────────────┐    MP3    ┌───────────┐
│ Palazzo  │ ────────────────→  │ Liquidsoap │ ────────→ │ Icecast2  │
│ (NestJS) │ ←── status ─────  │            │           │ :8000     │
└──────────┘                   └────────────┘           └───────────┘
      │
      ▼  HTTP REST API
  ┌──────┐
  │ Web  │
  │ UI   │
  └──────┘
```

## API

All endpoints return JSON. The server runs on port `3100` by default.

### Status

| Method | Path       | Description                                  |
|--------|------------|----------------------------------------------|
| `GET`  | `/status`  | Returns mount, stream name, uptime, running  |

### Song Queue

| Method | Path         | Description                                         |
|--------|-------------|-----------------------------------------------------|
| `POST` | `/song`      | Push a song URL into the queue. Skips current track. |
| `POST` | `/song/stop` | Skip the current song.                              |

### Instant Clips (jingles / sound effects)

| Method | Path            | Description                          |
|--------|-----------------|--------------------------------------|
| `POST` | `/instant`      | Push a short audio URL.              |
| `POST` | `/instant/stop` | Stop all currently playing instants. |

### Mixer (stub)

| Method | Path     | Description                              |
|--------|----------|------------------------------------------|
| `PUT`  | `/mixer` | Update volumes / mute. Not yet wired.    |

### Audio Proxy

| Method | Path                      | Description                                 |
|--------|---------------------------|---------------------------------------------|
| `GET`  | `/proxy-audio?url=<URL>`  | Fetch and relay audio from an external URL. |

### Example: Push a song

```bash
curl -X POST http://localhost:3100/song \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/song.mp3", "title": "My Song", "artist": "Me"}'
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

| Variable                   | Default         | Description                             |
|----------------------------|-----------------|-----------------------------------------|
| `PALAZZO_PORT`             | `3100`          | HTTP API port.                          |
| `ALLOWED_ORIGINS`          | *(empty)*       | Comma-separated CORS origins.           |
| `ICECAST_MOUNT`            | `/stream`       | Icecast mount point.                    |
| `ICECAST_PORT`             | `8000`          | Icecast streaming port.                 |
| `ICECAST_SOURCE_PASSWORD`  | `hackme`        | Icecast source authentication.          |
| `STREAM_NAME`              | `Palazzo`       | Public stream name metadata.            |
| `STREAM_GENRE`             | `Various`       | Public stream genre metadata.           |
| `BITRATE`                  | `128`           | MP3 bitrate in kbps.                    |
| `RTMP_URL`                 | *(disabled)*    | Optional RTMP live input URL.           |

The following variables from `.env.example` are reserved for future
multi-stream functionality and are **not used** by the current code:
`DOCKER_SOCKET_PATH`, `STREAM_IMAGE`, `STREAMS_WORKDIR`, `TELNET_PORT_START`,
`TELNET_PORT_END`, `ICECAST_HOST`, `ICECAST_ADMIN_PASSWORD`, `ICECAST_RELAY_PASSWORD`.

## Running

### Docker Compose (recommended)

```bash
cp .env.example .env    # edit the file first
docker compose up -d
```

The API will be available at `http://localhost:3100` and the radio stream
at `http://localhost:8000/stream` (or your configured mount point).

### Local development

```bash
npm install
npm run start:dev
```

You will need Liquidsoap and Icecast2 installed separately outside
the container for local dev.

## Architecture

### Liquidsoap script

At startup the service generates a Liquidsoap script with:
- **`songs` queue** — sequential main playlist (gapless).
- **`instants` queue** — interrupt clips that play over the current song.
- **Optional RTMP input** — live audio source mixed in when `RTMP_URL` is set.
- **Icecast output** — MP3 at the configured bitrate.

The script is written to `/tmp/palazzo/stream.liq` and Liquidsoap is spawned
as a child process. Communication happens over Liquidsoap's built-in Telnet
server on port `14000`.

### Lifecycle

1. **Startup** — `StreamService.onModuleInit()` generates the script, spawns
   Liquidsoap, and begins logging its output.
2. **Runtime** — HTTP endpoints send Telnet commands to push/skip audio in
   request queues.
3. **Shutdown** — `StreamService.onModuleDestroy()` kills the Liquidsoap process.

## Tech stack

- **[NestJS](https://nestjs.com/)** — TypeScript HTTP framework (Fastify adapter).
- **[Liquidsoap](https://www.liquidsoap.info/)** — Audio stream generator.
- **[Icecast2](https://icecast.org/)** — MP3 streaming server.
- **Docker** — Single-container deployment with Docker Compose.

## License

MIT
