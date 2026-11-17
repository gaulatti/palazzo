# Program-scoped playout

Palazzo exposes a private machine-to-machine surface under
`/v1/programs/{programId}`. The configured `PROGRAM_ID` is the only accepted
scope; another program returns 404.

## Atomic song and recorded intro

`POST /v1/programs/{programId}/playback/song` requires
a bounded `Idempotency-Key`.
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

After a Palazzo process restart, the first program-scoped song command moves a
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

## Song request time limit

Liquidsoap downloads the whole song file before it plays it, and gives each
song request a fixed time to resolve. `SONG_REQUEST_TIMEOUT_MS` sets that
limit explicitly in the generated script
(`songs_queue = palazzo_song_queue(id="songs", timeout=29.)`). It defaults to
`29000`, which is Liquidsoap 2.4.5's own `settings.request.timeout`, so the
default changes nothing. Integer values are clamped to 5,000–120,000 ms; a
non-integer value uses the default.

A song plays only if **file size ÷ throughput to the media store < the limit**.
A 3:30 song at 320 kb/s is 8,403,112 bytes, so at the default 29 s it needs at
least about 2.3 Mbit/s of effective throughput, and at 60 s about 1.12 Mbit/s.
On a slower link the download is cut off at the limit, the song never plays and
the filler covers, as before. The ffprobe preflight reads only about 64 KB, so
it passes on such a link and does not catch this case. Raising the limit also
lengthens the dead air before the filler on a link that is truly down.

The limit applies to songs only. The `intros` and `instants` queues keep
Liquidsoap's default of 29 s: they carry short clips, and an intro that fails
already falls back to the song alone with `intro.failed`.

The song queue is a copy of Liquidsoap 2.4.5's `request.queue`, with the same
methods and the same `songs.*` server commands, whose `next()` resolves each
request itself where `request.dynamic` would. When a song request cannot be
resolved, Liquidsoap journals it once and Palazzo publishes
`playout.request_failed` for that playback, with `playbackRequestId`,
`playbackId`, `programId` (`null` on the legacy route) and `reason`, and
counts it in `palazzo_song_request_failures_total{reason}`:

- `timeout`: the resolution took the limit (within 0.5 s; the HTTP download
  stops at the limit).
- `other`: it failed sooner, for example an HTTP error or an invalid URI.

The event uses Liquidsoap's own timestamp and appears on the SSE stream in
sequence with the playback's other events, within one telemetry poll (100 ms
by default). A song rejected by its probe never reaches Liquidsoap, so it is
reported once, by `preflight.failed`. A file that downloads in time but cannot
be decoded is still dropped by Liquidsoap without this event.

## Song segue and loudness

`POST /playback/song` accepts two optional analysis groups inside `song`, next
to `url`, `playbackId`, `title`, `artist` and `coverUrl`, as Alcantara sends
them, plus an optional `song.duration` in seconds:

```ts
segue?: { cueInSeconds; cueOutSeconds; fadeInSeconds; fadeOutSeconds; overlapSeconds }
loudness?: { integratedLufs; truePeakDbtp }
```

Palazzo validates each group itself and never trusts the sender:

- **segue**: every value finite; `0 ≤ cueInSeconds < cueOutSeconds`;
  `cueOutSeconds ≤ duration` when `song.duration` is present (a present
  duration that is not a finite number also invalidates the group); fades
  `≥ 0`; `0 ≤ overlapSeconds ≤ cueOutSeconds − cueInSeconds`.
- **loudness**: both values finite; `−70 ≤ integratedLufs ≤ 0`;
  `truePeakDbtp ≤ +6`.

An invalid group is dropped and counted in
`palazzo_song_analysis_dropped_total{group="segue|loudness",result="invalid"}`.
The song still plays without that group. A bad optional group never rejects
the command. Intro objects never carry these fields and are not read for them.

A valid group becomes Liquidsoap request annotations on the song only:

| Group    | Annotation                                             | Applied by                                                        |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| segue    | `liq_cue_in`, `liq_cue_out` (seconds)                  | Liquidsoap 2.4.5 request resolution cuts the file                 |
| segue    | `liq_fade_in`, `liq_fade_out` (seconds)                | `fade.in` / `fade.out` on the song chain (default duration 0)     |
| loudness | `liq_amplify` (linear gain)                            | `amplify(override="liq_amplify", 1., …)` before `song_volume`     |

The gain is `10^((target − integratedLufs)/20)`, capped so that
`truePeakDbtp + 20·log10(gain) ≤ ceiling`. Palazzo owns both values:

- `PLAYOUT_TARGET_LUFS`: integrated loudness target, default `−16`, allowed
  `−70` to `0`.
- `PLAYOUT_TRUE_PEAK_CEILING_DBTP`: true-peak ceiling, default `−1`, allowed
  `−20` to `0`.

An unset or blank value uses the default. Any other value outside its range
fails startup.

`overlapSeconds` is honoured only for an announced next song (below): it is how
long before its cue-out the current song lets the next one in. A song command
alone still hands off exactly as before.

A command without either group pushes exactly the same `songs.push` request as
before, and the added operators are no-ops without their annotations:
`liq_amplify` defaults to `1.`, and both fades default to a duration of `0.`.
Intros, instants, filler and mixer volumes are unchanged.

## Announced next song (gapless handoff and overlap)

`PUT /v1/programs/{programId}/playback/next` announces the song that follows the
one on air (gaulatti/palazzo#40). It takes the song command's `song` object
(no `intro`) and an `Idempotency-Key`. Palazzo probes it, then resolves it in the
background while the current song plays, and starts it itself: on the frame the
current song reaches its cue-out, or `overlapSeconds` (the current song's) before
it, with both audible in that window. There is no gap to cover with the filler.

| status | body | meaning |
|---|---|---|
| 200 | `{ok, playbackRequestId, state:"queued"}` (`duplicate:true` on a repeat) | probed and preparing; the outcome is the event below or the song's own `track.started` |
| 409 | `{ok:false, reason:"no_current_song"}` | nothing on air; use the song command |
| 422 | `{ok:false, reason:"not_ready"}` | the probe failed; nothing queued |
| 400 | `{ok:false, reason:"invalid"}` | invalid body or key |

`DELETE …/playback/next` withdraws it (`{ok, withdrawn}`). One song is announced
at a time; a new announcement replaces the previous one.

- Resolution is limited to the current song's remaining time, capped by
  `PLAYOUT_NEXT_RESOLVE_MAX_SECONDS` (default 600), not by
  `SONG_REQUEST_TIMEOUT_MS`. If the song is not resolved when the current one
  ends, it is withdrawn (`not_ready`) before that song's `track.ended`, and the
  caller sends it as a song command, exactly today's handoff.
- Once the announced song has started (under an overlap, or at the cue-out) it
  is on air: a new announcement is refused with 422 `not_ready`, and `DELETE`
  answers `withdrawn:false`. A song command or a stop ends it like any song.
- A song command or a stop flushes the announced song (`flushed`): it never
  plays unless it is the one chosen. Before the first announcement these
  commands send the telnet commands they always did, after
  `palazzo.mark_ending` (see [why a track ended](playback-telemetry.md#why-a-track-ended));
  after it they also send `palazzo.reset_decks` before cutting. The songs both
  decks have on air at that moment are reported with the command's reason.
- Events: `playout.next_queued {programId, playbackId}` and
  `playout.next_withdrawn {programId, playbackId, reason}` with reason
  `replaced`, `withdrawn`, `flushed` or `not_ready`. Without overlap the order is
  `track.ended` (current) then `track.started` (next); with overlap it is
  `track.started` (next) at cue-out minus the overlap, then `track.ended`
  (current) at its cue-out. Every song has exactly one of each.
- Headroom: while both songs are on air a limiter holds the sum under the
  true-peak ceiling, and a song entering under an overlap rises over at least
  0.25 s. With one song the limiter is dry (bit-identical output).
- Mechanism: two song decks. Deck `a` is the existing `songs` queue; the
  announced song waits resolved on the idle deck behind a closed gate and starts
  when the gate opens. A deck still finishing an overlapped song is never
  paused: the next song waits for it.

Measured on the real image (local and 20 Mbit/s remote 8.4 MB files): handoff
silence at or below 20 ms against 280–480 ms with song commands alone; overlap
2.0 s within ±0.1 s; two full-scale songs overlapped at −1.8 dBTP.

## Program surface

All routes are confined to the private control network and exact configured program.

| Method | Route (under `/v1/programs/:programId`) | Purpose                                                                                                                      |
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

The event stream adds `intro.started`, `intro.ended`, `intro.failed`, and
`playout.request_failed` (see Song request time limit).
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

The legacy unscoped root playback routes were removed after Alcantara migrated;
they return the framework's normal 404 with no redirect or fallback. This
program-scoped contract is the sole playback control plane.
