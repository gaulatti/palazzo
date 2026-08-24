# Broadcast automation lifecycle

One Palazzo instance owns one configured Alcantara program with a radio leg.
The Liquidsoap process and Icecast source mount are 24x7 transport; Start and
Stop control program automation without creating or destroying that transport.

## Private API

The API is bound to host loopback by the supplied Compose stack and joins the
private external `broadcast-control` network. Only the Icecast listener mount
may be published separately. Configure `PROGRAM_ID`, `PALAZZO_INSTANCE_ID`, and
a non-empty `PALAZZO_CONTROL_TOKEN_FILE` secret.

All lifecycle requests require `Authorization: Bearer <token>`. Start and Stop
also require a bounded `Idempotency-Key` and monotonically increasing positive
`X-Command-Sequence`.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/v1/programs/{programId}/automation` | Requested/actual state, readiness, transition, dependencies, authoritative playback, timestamps, and last command |
| `POST` | `/v1/programs/{programId}/automation/start` | Reach Ready without restarting Liquidsoap or Icecast |
| `POST` | `/v1/programs/{programId}/automation/stop` | Flush active and queued songs/instants, confirm idle, preserve the mount |

Another program ID returns 404 after authentication. Reusing a key for the
same command returns the current lifecycle state without repeating effects;
reusing it for another action or sequence returns 409. Raw keys and bearer
tokens are never returned, retained, or logged.

## State and failure semantics

On every Palazzo process boot, requested and actual state begin as
`reconciliation-required`. A healthy container is not evidence that an earlier
operator command succeeded. Alcantara must reconcile with a new Start or Stop.

Start changes requested state to `running`, waits for the Liquidsoap child,
private control/telemetry connection, and Icecast source output, then reports
`ready`. An empty song queue is valid Ready state. Once ready, ordinary song,
instant, and mixer commands are accepted.

Stop sends Liquidsoap 2.4.5's `flush_and_skip` command to both request queues,
then waits for authoritative song-idle and zero instant activity. It reports
Stopped only after that observation. Liquidsoap and Icecast remain running and
connected, so listeners retain the 24x7 mount and hear the existing safe idle
source. A later Start begins without stale program material.

Queue exhaustion, silence, an Alcantara outage, or a publisher/control failure
never creates an explicit Stop. While requested state remains running, losing
Liquidsoap, control telemetry, or Icecast changes actual state to `degraded`
and identifies each dependency separately. A failed queue clear or readiness
timeout returns 503 and `failed`; a newer command is required to reconcile.

## Deployment prerequisites

Local Compose requires the external `broadcast-control` network and the token
file configured by `PALAZZO_CONTROL_TOKEN_FILE`:

```bash
docker network create broadcast-control
mkdir -p secrets
openssl rand -hex 32 > secrets/palazzo-control-token
```

Production deployment fails closed unless the host already has a non-empty
regular file at `/etc/palazzo/control-token`, the `broadcast-control` network,
and the GitHub Actions `PROGRAM_ID` repository variable. Before replacing the
live container, the workflow starts the immutable commit image as a candidate
and verifies its transport and authenticated lifecycle API. It retains the old
container for rollback until those checks pass in production. Provisioning or
rotating the production token is a separate operator action; the workflow only
mounts it read-only.

## Recovery checks

1. After process restart, confirm the lifecycle says
   `reconciliation-required` even if transport is healthy.
2. Issue Start with a new key/sequence and confirm Ready with an empty queue.
3. Play a song and instant, then issue Stop; confirm both queues are flushed,
   playback is idle, and `dependencies.icecast` stays true.
4. Interrupt Telnet or Liquidsoap and confirm actual state becomes degraded,
   not stopped.
5. Disconnect Icecast and confirm the Icecast dependency becomes false while
   requested automation state remains unchanged.
