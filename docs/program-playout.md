# Program-scoped playout

Palazzo exposes an authenticated machine-to-machine surface under
`/v1/programs/{programId}`. The configured `PROGRAM_ID` is the only accepted
scope; another program returns 404 after bearer authentication.

## Atomic song and recorded intro

`POST /v1/programs/{programId}/playback/song` requires
`Authorization: Bearer <control-token>` and a bounded `Idempotency-Key`.
Alcantara supplies authoritative URLs and IDs:

```json
{
  "song": {
    "programId": "program-1",
    "playbackId": "song-playback-42",
    "url": "https://media.example/song.mp3",
    "title": "Title",
    "artist": "Artist",
    "coverUrl": "https://media.example/cover.jpg"
  },
  "intro": {
    "programId": "program-1",
    "playbackId": "intro-playback-42",
    "url": "https://media.example/intro.mp3",
    "gain": 0.8,
    "duckGain": 0.3,
    "fadeInSeconds": 0.15,
    "fadeOutSeconds": 0.2
  }
}
```

Palazzo probes the song and optional intro before replacing the current song.
The probe opens at least one audio packet and verifies format, duration, codec,
sample rate, and channel count. A missing, corrupt, timed-out, unreachable, or
non-audio song is quarantined and rejected before any Liquidsoap command. An
invalid intro follows the explicit `song_only` fallback policy. It emits
`preflight.failed`, `intro.failed`, and `playout.fallback` without exposing the
media URL.
It durably reserves the idempotency key, preloads the intro queue, arms it for
the supplied parent song ID, and replaces the song. Liquidsoap keeps the intro
source unavailable until that exact song begins, so an intro cannot play over
the previous song or without its parent. Retries return the original IDs with
`duplicate: true`; key reuse with a different body is rejected. The bounded
journal lives on the persistent Palazzo data volume, preserving at-most-once
behavior across process and container restarts.

After a Palazzo process restart, the first authenticated song command moves a
healthy transport from `reconciliation-required` to Ready before entering the
playback queue. It still fails closed if Liquidsoap, its control telemetry, or
the Icecast source connection is unavailable. Explicit lifecycle Start is
required when Alcantara needs to bind a prepared filler version.

The default journal path is
`/var/lib/palazzo/fillers/playout-commands.json`, inside the existing
`palazzo-fillers` volume. `PLAYOUT_COMMAND_JOURNAL_PATH` may override it for
isolated tests.

An unavailable intro degrades to song-only playout and publishes
`intro.failed`. An unavailable song rejects the whole command before either
queue changes.

The dedicated intro source applies the asset's authored `gain`, per-item
fades, and `duckGain` to the song mix. Manual instants remain on the separate
`instants` bus and are never ducked by this operation.

## Program surface

All routes require the same program-scoped bearer authentication.

| Method | Route                    | Purpose                                                                                                                      |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/playback/song`         | Atomic song plus optional intro                                                                                              |
| POST   | `/playback/song/stop`    | Stop the song queue                                                                                                          |
| PUT    | `/playback/preflight`    | Probe a bounded list of upcoming assets                                                                                      |
| GET    | `/playback/preflight`    | Read current ready/quarantined/expired states                                                                                |
| POST   | `/playback/instant`      | Play an independent manual instant; body includes matching `programId`, authoritative `playbackId`, URL, and optional volume |
| POST   | `/playback/instant/stop` | Stop manual instants                                                                                                         |
| GET    | `/playback/state`        | Authoritative song, intro, position, and levels                                                                              |
| GET    | `/playback/events`       | Replay-safe SSE lifecycle stream                                                                                             |
| GET    | `/mixer`                 | Applied mixer state                                                                                                          |
| PUT    | `/mixer`                 | Update mixer state                                                                                                           |

The event stream adds `intro.started`, `intro.ended`, and `intro.failed`.
Each event carries the intro playback ID, parent song playback ID, program ID,
request correlation. State exposes the active or most recent failed intro.
SSE data removes all URL- and credential-shaped fields; callers obtain signed
media URLs from their scheduling owner, never from the event journal.

## Ahead-of-air preflight

`PUT /v1/programs/{programId}/playback/preflight` accepts a bounded batch of
upcoming assets:

```json
{
  "assets": [
    {
      "programId": "program-1",
      "playbackId": "song-playback-42",
      "kind": "song",
      "url": "https://media.example/signed/song.mp3",
      "scheduledAt": "2026-09-06T18:15:00.000Z"
    }
  ]
}
```

The default lookahead is 900 seconds, batch size is 20, concurrency is two,
readiness retention is 300 seconds, and probe timeout is ten seconds.
Configuration is clamped to 1–86,400 seconds of lookahead, 1–100 assets per
batch, 1–8 concurrent probes, 1–512 retained states, 1–3,600 seconds of TTL,
and 100–30,000 ms per probe. Work outside the window is deterministically
quarantined as `outside_lookahead`. Readiness metadata is a bounded
least-recently-used cache; Palazzo deliberately warms zero media bytes so it
does not assume ownership of expiring signed content.

Each response reports `ready`, `quarantined`, or `expired`, a closed reason,
`checkedAt`, `expiresAt`, and verified media facts. A matching unexpired URL
digest is reused. The public result never returns the URL or its digest.

The private metrics endpoint exposes
`palazzo_paired_playout_commands_total` and
`palazzo_intro_lifecycle_total`. Their result and reason labels are closed
enums; IDs, URLs, program names, and error strings never become labels. The
preflight and transition contracts add `palazzo_media_preflight_total` and
`palazzo_playout_transitions_total` with closed reason/event labels.

See [Media preflight runbook](media-preflight-runbook.md) for quarantine,
fallback, and consumer recovery procedures.

Legacy root routes remain available during Alcantara migration, but new callers
should use this program-scoped contract.
