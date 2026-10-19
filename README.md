# Palazzo

Self-hosted internet radio station controller — REST API to push songs, jingles, and live audio into a Liquidsoap/Icecast stream.

Single Docker container: NestJS + Liquidsoap + Icecast2.

## Quick Start

```bash
cp .env.example .env
docker network create broadcast-control 2>/dev/null || true
docker compose up -d
```

API: `http://localhost:3100` — Stream: `http://localhost:8000/stream`

## API

Automation clients should use the private program-scoped surface in
[Program-scoped playout](docs/program-playout.md). It provides atomic
song-plus-intro playout, program-scoped instant/mixer/state/event routes,
durable idempotency, and explicit intro lifecycle reporting.

Push a song: `POST /song` with `{"url": "https://...mp3"}`

All endpoints at a glance:

| Method | Path                                       | Description                                               |
| ------ | ------------------------------------------ | --------------------------------------------------------- |
| `GET`  | `/status`                                  | Stream health and metadata                                |
| `GET`  | `/playback/state`                          | Authoritative current playback snapshot                   |
| `GET`  | `/playback/events`                         | Replay-safe Server-Sent Events                            |
| `GET`  | `/metrics`                                 | Private Prometheus telemetry                              |
| `GET`  | `/v1/programs/:programId/automation`       | Private automation lifecycle state                        |
| `POST` | `/v1/programs/:programId/automation/start` | Start the program automation without restarting transport |
| `POST` | `/v1/programs/:programId/automation/stop`  | Clear program material while preserving the Icecast mount |
| `PUT`  | `/v1/programs/:programId/fillers/:version` | Prepare immutable local radio filler from private Alcantara input |
| `GET`  | `/v1/programs/:programId/fillers/:version` | Read filler readiness without exposing signed source data |
| `POST` | `/song`                                    | Push a song, skips current                                |
| `POST` | `/song/stop`                               | Skip current song                                         |
| `POST` | `/instant`                                 | Push a jingle/SFX                                         |
| `POST` | `/instant/stop`                            | Stop all instants                                         |
| `GET`  | `/v1/programs/:programId/output/audio` | Return the configured Icecast audio on the private API |
| `GET`  | `/mixer`                                   | Read the applied song, instant, and main mixer state      |
| `PUT`  | `/mixer`                                   | Apply song, instant, and main volume/mute controls        |
| `GET`  | `/proxy-audio?url=`                        | CORS proxy for audio URLs                                 |

`POST /song` and `POST /instant` accept an optional caller-supplied
`playbackRequestId`, generating one when omitted. Song metadata and that ID
travel with the Liquidsoap request and reappear in lifecycle,
position, and state telemetry. Level samples are emitted at no more than 10 Hz,
position at 1 Hz, and heartbeats approximately every 10 seconds.

The control API, SSE feed, metrics, and Liquidsoap command socket are private
interfaces. The provided Compose and deployment mappings bind
the API to host loopback and join the private `broadcast-control` network;
publish only Icecast (or route it through a reverse proxy) for listeners.
On Cumulus, nginx exposes the same stream at `palazzo.gaulatti.com` and the
Modo Italiano listener hostname `radio.modoitaliano.fm`; the latter redirects
its root to `/stream` and includes the public CORS header used by radio clients.

Container application logs use Docker's host-local `local` driver, bounded to
three 10 MB files per container. Operators can inspect them with
`docker logs --tail 200 palazzo`; Palazzo does not send application logs to
CloudWatch.

For a failed Cumulus deployment, the GitHub Actions job shows SSM remote stdout
and stderr as separate lines and annotates the remote exit code. A missing
deployment token is reported by name without showing its value.

Palazzo boots in `reconciliation-required`: container or process startup never
pretends a prior operator Start/Stop succeeded. Alcantara reconciles it through
the private lifecycle API. Start becomes ready only when Liquidsoap, its
control/telemetry connection, and the Icecast source output are healthy. Stop
flushes both queues and waits for authoritative idle while leaving Liquidsoap
and the 24x7 Icecast mount connected. See
[docs/broadcast-lifecycle.md](docs/broadcast-lifecycle.md).

Full details: [API Reference](wiki/API-Reference)

Telemetry operations and migration guidance:
[docs/playback-telemetry.md](docs/playback-telemetry.md).

## Pull request verification

Every PR runs unit tests with exact 100% line and branch coverage over all
application sources, type-checking, the production dependency audit, workflow
security tests, and real Liquidsoap/Icecast container checks. Run
`npm run test:coverage` locally with Node 22.22.0 and ffmpeg/ffprobe installed.
Native c8 reports include unloaded bootstrap/module files; Clouseau independently
checks the complete source inventory and exact counters.

After those checks pass, the pinned Clouseau reviewer assesses purpose, need,
proportionality, technical findings and test integrity. Jev grades its qualified
narrow factors; independent DeepSeek reviews handle the remaining questions.
Passing reviews receive a bot approval and native auto-merge under main's branch
protection. Unresolved product-direction decisions go to gaulatti. Intent
confirmation never waives tests, coverage or integrity. See
[the purpose contract](.github/clouseau.md) and
[Continuous Verification](https://github.com/gaulatti/palazzo/wiki/Continuous-Verification).

Verification and AI review run separately: metadata reassessment does not rebuild
the container, and provider calls wait for real verification to finish. A bot
merge explicitly dispatches the existing deployment workflow for runtime changes;
deployment completion and live stream health remain separate checks.

## Post-deployment wiki documentation

A successful `Deploy` workflow runs Clouseau's wiki generator against the exact
deployed source revision and the existing wiki. It plans all affected pages
together, generates the required changes and checks their factual support and
internal links. A separate publisher verifies deployment again and publishes the
complete update in one non-force Git commit. Failed deployment, unsupported
claims or concurrent human wiki edits prevent publication.

`.github/clouseau-wiki.json` selects the public source evidence and binds
publication to the `deploy` job in `deploy.yml`. The generator has read-only
permissions and the DeepSeek key; the publisher has wiki write permission and no
provider key. Drafts and diagnostics are retained by workflow run and attempt.
An already documented source revision skips model calls.

For a read-only preview, dispatch `Deploy` with `validate_wiki_only=true`. This
skips the build and deployment jobs, validates the generated draft and checks
wiki write access with a dry run. It does not publish the draft.

Documentation is its own delivery stage. Ticket closeout remains a separate
stage; publishing wiki pages does not close issues or declare a ticket solved.

If the installed reviewer prevents installing its verified replacement, the
repository owner can dispatch **Palazzo CI** from the exact ready PR head with
`install_reviewer=true` and `pull_request` set to that PR number. Before using
provider credentials, a read-only guard requires the owner actor, an owner-authored
same-repository PR targeting `main`, the exact workflow/head revision and an owner
`/approve-intent FULL_HEAD_SHA` comment. The pinned replacement reviews the change
against the purpose and configuration on protected `main`, after the independent
PR tests, exact coverage and container checks pass. The separate gate retains all
scoring, integrity and branch-protection requirements; no failed result is waived.
Ordinary PR review continues to use the workflow and pinned reviewer on `main`.
Workflow integration tests also execute the pinned coverage action against the
real native report produced by `npm run test:coverage`, including rejection of
an uncovered application branch. Run application coverage before these tests.

## Documentation

- [Architecture](wiki/Architecture) — System design, data flow, Liquidsoap engine
- [API Reference](wiki/API-Reference) — All endpoints with request/response schemas
- [Configuration](wiki/Configuration) — Environment variables and settings
- [Deployment](wiki/Deployment) — Docker, Compose, CI/CD
- [Development](wiki/Development) — Local setup and project structure

## License

MIT

## Program audio return

Alcántara monitors the encoded output through
`GET /v1/programs/:programId/output/audio`. Palazzo connects only to its own
configured `ICECAST_PORT`/`ICECAST_MOUNT` on loopback, preserving content type
and forwarding bytes incrementally. This private program-scoped endpoint needs
no public listener hostname. Closing the client closes the Icecast connection
without changing broadcast playback. See the wiki API Reference for errors and
monitor metrics.

Production dependency verification uses `npm audit --omit=dev --audit-level=high`.
The Fastify override pins 5.12.5 while keeping NestJS on version 11; remove or
update it only after the adapter resolves a patched version and the HTTP/runtime
gates pass. The unused Dockerode SDK is removed: Palazzo manages its Liquidsoap
child process directly. These dependency corrections preserve metric contracts.
