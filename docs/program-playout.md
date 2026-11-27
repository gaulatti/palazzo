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
An instant's own `volume` and an intro's own `gain` (each a number in [0, 1], validated at the
API and clamped to that range where Alcantara stores it) reach Liquidsoap as the `liq_amplify`
annotation and are applied per item by `amplify(override="liq_amplify", ...)` on the instants and
intros chains; the station instant volume multiplies on top for instants. The value is validated
in the script before it is read (`item_gain`): a finite number in [0, 1], else 1. An absent value
(spots announced with the next song carry no volume) is 1 and silent; any other value that is not a
finite number in [0, 1], whatever its source (the request or the item's own metadata), leaves the
item at its file's level instead of silencing it or making it louder, and is logged once with a
line naming the item's request id and URL (`item_gain: ignored an invalid gain for <id> (<url>)`),
so the file can be found. The song chain's `liq_amplify` is its computed loudness gain and is not
affected. `test/runtime/verify-item-gain.sh` checks this on the real image (0.5 against 1 is about
6 dB for both queues, invalid values read as 1 with one log line each, and a song's level is
unchanged by an instant over it).

An instant, a spot and an intro never take cue points or tags from their audio file
(gaulatti/palazzo#60). Liquidsoap applies the `liq_cue_in` and `liq_cue_out` values it finds in an item's
metadata when it resolves the request, and a file can carry them in its own tags; Palazzo sets cue points only
for songs (from their analysis), so on these three any cue value is the file's. They are therefore
**ignored, not clamped**: the request is annotated with `liq_cue_in=""` and `liq_cue_out=""`
(`NO_FILE_CUE` in `stream.service.ts`), which overrides the file's tag, and the item plays whole. Measured
on Liquidsoap 2.4.5 with a 4 s clip: a file cue-out of 0.5 played 0.5 s and a cue-in of 2.5 played 1.5 s
without the annotation, and the whole clip with it. A clamp would still let a file shorten an item that Palazzo
never asked to shorten. The song chain is untouched (its cue annotations come from the analysis only; a unit
test pins that a song request carries none of these keys without it).
`test/runtime/verify-item-cue.sh` checks it on the real image: an instant and an intro each play about 4 s of a
4 s tone whether the file carries a cue-out, a cue-in or nothing.

**An intro's own title and artist.** Assessed on the real image with an intro file tagged `title`/`artist`:
they did not reach the Icecast stream title (the stream showed the song's title throughout), but they did
reach the playback events (`intro_started`, `intro_ended` and the other lifecycle events that carry the
item's `title` and `artist`), which Alcantara consumes. The intros mapper therefore blanks `title`, `artist` and
`song` as the instants mapper does (Palazzo annotates none for an intro), so an intro's events carry no
tags from its file. `verify-item-cue.sh` fails if the file's tags appear on the stream or on the events.

Intros, instants, filler and mixer volumes are unchanged.

## Cue points (gaulatti/palazzo#53)

A valid `segue` group's `cueInSeconds` and `cueOutSeconds` are annotated as
`liq_cue_in` and `liq_cue_out`. Liquidsoap 2.4's `request.create` applies them
itself (`cue_cut` is built into request resolution). So the song plays from
cue-in to cue-out, and its end, its handoff, its remaining time and every
position hook (the overlap point, the spot lead, `track_ended`) are on that
trimmed clock. Measured on 2.4.5: a 16 s file cued 3–13 s reports 9.86 s
remaining and hands off after 9.95 s.

Each edge is bounded at 10 s (`CUE_EDGE_BOUND_SECONDS`, the same bound as
Alcantara's). An edge over it is not annotated, so that edge plays untrimmed,
and it is counted. The tail is bounded against the announcement's probed file
length, else the payload's `duration`; with neither, the cue-out is applied as
sent. `liq_fade_in` and `liq_fade_out` are annotated, but no operator reads
them, so no fade is applied.

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
  plays unless it is the one chosen. Both first journal why the songs on air end,
  with `palazzo.mark_ending` (see [why a track ended](playback-telemetry.md#why-a-track-ended)).
  A stop then sends `palazzo.reset_decks` (once announcements were used) and
  `songs.flush_and_skip`. A song command sends `palazzo.command_song` (see
  [a song command prepares its song](#a-song-command-prepares-its-song-gaulattipalazzo66)),
  which resets the decks at the cut, once the new song is ready.
- Events: `playout.next_queued {programId, playbackId}` and
  `playout.next_withdrawn {programId, playbackId, reason}` with reason
  `replaced`, `withdrawn`, `flushed` or `not_ready`. Without overlap the order is
  `track.ended` (current) then `track.started` (next); with overlap it is
  `track.started` (next) at cue-out minus the overlap, then `track.ended`
  (current) at its cue-out. Every song has exactly one of each.

### A spot before the announced song (`bumper`, gaulatti/palazzo#50)

`GET …/playback/state` lists `"next.bumper"` in `capabilities`. A client sends
`bumper` only when it is listed; a Palazzo without the capability ignores the
field. The announcement then takes an optional

```json
"bumper": { "playbackId": "<id>", "url": "<spot audio URL>" }
```

The spot belongs to the program the request names. Its `playbackId` has no
whitespace and differs from the song's, otherwise the request is a 400
`invalid`. Palazzo resolves the spot alongside the song, within the same time
limit, and sends it to Liquidsoap with `palazzo.prepare_bumper`. Then:

- 0.12 s before the playing song's end (`BUMPER_LEAD_SECONDS`), the spot goes on
  air from the instants queue. The announced song's gate stays closed, and
  opens on the frame the spot's own track ends. With a spot there is no
  overlap. Measured on Liquidsoap 2.4.5 (`test/runtime/verify-bumper.sh`): the
  spot started 10 ms before the song's end and the song 20 ms after the spot's
  end.
- A spot never holds the song. The song's gate opens at the playing song's end
  (never earlier, so the playing song is never cut) in these cases:
  - the spot is not resolved by then (`dropped_unresolved`);
  - Liquidsoap refuses it;
  - it fails before going on air;
  - it is not on air within 1 s (`dropped_failed`).

  A spot on air for more than 60 s is cut and the song starts
  (`dropped_late`). A spot that played counts as `played`. All four results
  are counted in `palazzo_next_bumper_total{result}`.
- The announcement is accepted even when the spot is dropped; the song then
  plays at the end as without one.
- Withdrawing or replacing the announcement drops a spot that is not on air
  yet. A song command or a stop does the same, through
  `palazzo.reset_decks` → `drop_next("flushed")`. A song command that arrives
  while the spot is on air leaves the spot to play out, and the commanded song
  starts as soon as it loads, over the end of the spot.
- A spot opens only the gate of the announcement it was played for. Its start
  records the announcement's generation, and its end (or its 1 s or 60 s
  timeout) opens the gate only if that announcement is still the queued one.
  A song announced after a command, while the leftover spot still plays, waits
  for the commanded song's own end. Before this, the spot's end opened that new
  announcement's gate, and the two decks played summed: two songs on air at
  once (2026-11-21 08:10–08:14Z, after a backend restart during a spot).
  `test/runtime/verify-station.sh` checks this case.
- A spot dropped as not on air within 1 s is also removed from the instants
  queue. If it still comes on air it is skipped at once, so nothing of it plays
  over the song (verified with a spot held behind a 14 s clip fired by hand).
- Every instant, a spot or one fired by hand, is journalled as
  `instant_started` / `instant_ended`. The journal's `playback_request_id`
  field carries the instant's playback id; for a spot it is the `bumper`
  `playbackId`. SSE relays them as `instant.started` / `instant.ended`
  `{playbackId, programId, liquidsoapSequence}`. As-run and royalties read the
  spot's real play from these events.
- The bumper interval and the choice of spot stay with the client (Alcantara,
  gaulatti/alcantara#232).
- Cold song changes (a song command) prepare their song before the cut: see the
  next section (gaulatti/palazzo#66).
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

## A song command prepares its song (gaulatti/palazzo#66)

A song command (`POST /v1/programs/:programId/playback/song`) used to cut the
song on air first (`songs.flush_and_skip`) and push the new song after, so the
new file was fetched from the media origin and decoded while the air was quiet:
1.0 to 1.4 s of digital silence on the cold changes measured on 2026-11-21. An
announced song never had this gap, because it waits resolved on the idle deck.

Now the command sends `palazzo.command_song <limit> <uri>` with a limit of
`COMMAND_PREPARE_LIMIT_SECONDS` (3 s). Liquidsoap resolves the song while the
song on air keeps playing, then cuts: the decks go back to the single song deck
(as `palazzo.reset_decks`), the song on air is skipped, and the resolved song is
pushed, so it starts on the next frame. The outgoing song plays up to the fetch
time longer instead of leaving that time silent.

- **Not ready within the limit:** the command cuts anyway, with the song still to
  resolve, as before. A command always acts within 3 s: an operator's play-now
  or skip never waits longer.
- **Not resolvable** (the fetch fails): the command cuts at once, as before, and
  the song queue journals the failure (`song_request_failed`).
- **A newer command, a stop or a clear** while a command is still preparing: the
  newest wins. Every command and every flush of the song queue takes a new
  generation, and a preparation that finishes for an older one is dropped, so the
  older song never plays and no deck is left holding it.
- **Metric:** `palazzo_song_command_prepare_total{result="ready|fallback|failed"}`
  counts how each preparation ended; `palazzo_song_change_gap_seconds{handoff="command"}`
  measures the handoff it leaves.

`test/runtime/verify-station.sh` checks the four paths on the real image: a
command whose song takes 1.5 s to fetch leaves no digital silence in the Icecast
output; a 5 s fetch cuts at the 3 s limit; a missing file cuts at once; and of
two back-to-back commands the newer one plays.

## Stream title during spots and instants (gaulatti/palazzo#54)

The Icecast stream title (`StreamTitle`, from `title` and `artist`) shows what is
on air:
- A song shows its own `title` and `artist` from the command, as before.
- An instant never puts its file's own tags on the stream. Before this, a spot
  file tagged with a song's title showed that title for the spot's whole length.
- A spot shows the station name (`STREAM_NAME`). That covers an announced spot
  (`bumper`), and an instant started with no song or intro on air, such as a spot
  by command or an instant in a gap. The song after it shows its own title.
- An instant over a song carries no title, so the song's title stays.
- The filler shows its own titles while it is actually on air, since that is
  what is playing.

How: the instants source is mapped (`instants_titles`) to the station name or to
no title. An announced spot is marked `palazzo_spot="true"` and starts just
before the song's end, while the song is still on air, so the mix drops its
metadata; its start hook puts the station name on the stream directly
(`radio.insert_metadata`). Checked on a real Liquidsoap and Icecast by
`test/runtime/verify-titles.sh`.

## Trailing-silence cue-out (gaulatti/palazzo#55)

A spot or an instant file can end in digital silence its operator never meant to air (production spots measured 0.57, 0.32, 0.25 and 0.16 s), which opens a gap before the announced song. When Palazzo prepares a spot or an instant it measures that silence and cues the item out at its last audio. The file is never changed, and the file's own cue tags stay ignored (gaulatti/palazzo#60): the cue comes only from this measurement.

- **Measurement:** `ffmpeg silencedetect=noise=-85dB:d=0.05` over the item's loopback relay address (`src/stream/trailing-silence.ts`). A silence counts as trailing when it runs to the end of the file. The duration is ffmpeg's `Duration:` line, else the last progress `time=` (a file read over HTTP can carry no duration header).
- **Cap:** the cue-out trims at most 1 s, so a long silent tail never cuts content. A trailing silence under 50 ms is not trimmed.
- **Annotation:** `liq_cue_in=""` and `liq_cue_out="<seconds>"`, or `liq_cue_out=""` (plays whole).
- **Never on the air path:** a play never waits for a measurement. A measured item (cached 10 minutes, 256 entries, oldest evicted) is cued out; an item not measured yet plays whole and is measured in the background (one at a time per item, a second relay fetch plus an ffmpeg decode, 20 s limit) for its next play. The cache key is the item's address without its query, so a signed address of the same object reuses it; a file replaced at the same address is measured again after the 10 minutes. A content key (an asset id or version from the sender) would be exact and is a follow-up.
- **Failure:** a failed measurement logs `item.trim.measure_failed`, counts `failed`, caches nothing, and the item keeps playing whole; the next play tries again.
- **Metric:** `palazzo_item_trim_total{kind="spot|instant",result="trimmed|whole|unmeasured|failed"}` (`unmeasured`: played whole while its first measurement runs).
- **Tests:** `test/trailing-silence.test.js` (parser and cap), `test/trailing-silence.ffmpeg.test.js` (real ffmpeg on a tone with 0.4 s of trailing silence; skipped without ffmpeg), `test/stream.service.test.js`, and `test/runtime/verify-spot-gap.sh` for the end-to-end gap.

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
