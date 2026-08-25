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
It durably reserves the idempotency key, preloads the intro queue, arms it for
the supplied parent song ID, and replaces the song. Liquidsoap keeps the intro
source unavailable until that exact song begins, so an intro cannot play over
the previous song or without its parent. Retries return the original IDs with
`duplicate: true`; key reuse with a different body is rejected. The bounded
journal lives on the persistent Palazzo data volume, preserving at-most-once
behavior across process and container restarts.

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

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/playback/song` | Atomic song plus optional intro |
| POST | `/playback/song/stop` | Stop the song queue |
| POST | `/playback/instant` | Play an independent manual instant; body includes matching `programId`, authoritative `playbackId`, URL, and optional volume |
| POST | `/playback/instant/stop` | Stop manual instants |
| GET | `/playback/state` | Authoritative song, intro, position, and levels |
| GET | `/playback/events` | Replay-safe SSE lifecycle stream |
| GET | `/mixer` | Applied mixer state |
| PUT | `/mixer` | Update mixer state |

The event stream adds `intro.started`, `intro.ended`, and `intro.failed`.
Each event carries the intro playback ID, parent song playback ID, program ID,
request correlation, and authoritative URL where applicable. State exposes the
active or most recent failed intro.

The private metrics endpoint exposes
`palazzo_paired_playout_commands_total` and
`palazzo_intro_lifecycle_total`. Their result and reason labels are closed
enums; IDs, URLs, program names, and error strings never become labels.

Legacy root routes remain available during Alcantara migration, but new callers
should use this program-scoped contract.
