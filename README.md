# Palazzo

Self-hosted internet radio station controller — REST API to push songs, jingles, and live audio into a Liquidsoap/Icecast stream.

Single Docker container: NestJS + Liquidsoap + Icecast2.

## Quick Start

```bash
cp .env.example .env
docker compose up -d
```

API: `http://localhost:3100` — Stream: `http://localhost:8000/stream`

## API

Push a song: `POST /song` with `{"url": "https://...mp3"}`

All endpoints at a glance:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Stream health and metadata |
| `POST` | `/song` | Push a song, skips current |
| `POST` | `/song/stop` | Skip current song |
| `POST` | `/instant` | Push a jingle/SFX |
| `POST` | `/instant/stop` | Stop all instants |
| `PUT` | `/mixer` | Volume/mute (stub) |
| `GET` | `/proxy-audio?url=` | CORS proxy for audio URLs |

Full details: [API Reference](wiki/API-Reference)

## Documentation

- [Architecture](wiki/Architecture) — System design, data flow, Liquidsoap engine
- [API Reference](wiki/API-Reference) — All endpoints with request/response schemas
- [Configuration](wiki/Configuration) — Environment variables and settings
- [Deployment](wiki/Deployment) — Docker, Compose, CI/CD
- [Development](wiki/Development) — Local setup and project structure

## License

MIT
