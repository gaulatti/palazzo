# Immutable radio filler preparation

Palazzo prepares versioned, program-scoped radio filler before a broadcast
session starts. Alcantara owns the private commands; Palazzo owns downloads,
validation, durable local storage, and Liquidsoap playback. Once preparation
finishes, playback does not depend on Alcantara, object storage, signed URLs, or
network availability.

## Private API

All routes require the exact `PROGRAM_ID` on the private control network as the
broadcast lifecycle API.

| Method | Path | Purpose |
| --- | --- | --- |
| `PUT` | `/v1/programs/{programId}/fillers/{version}` | Prepare or idempotently inspect an immutable version |
| `GET` | `/v1/programs/{programId}/fillers/{version}` | Read bounded readiness or failure state |

`PUT` also requires `Idempotency-Key`; the JSON `commandId` must match it.
`assets` contains one to 100 `{id, sha256, downloadUrl}` objects. `mode` is
`ordered` or `shuffle`; shuffle also requires a bounded `shuffleSeed`. A
`mode` string Palazzo does not know is prepared as `ordered` (and its identity
uses `ordered`) instead of refusing the filler, and is counted in
`palazzo_filler_unknown_modes_total` (gaulatti/ariston#217): ordering is not
safety, and a refused filler blocks automation start. A `mode` that is not a
string is still a 400.
Refreshing an expiring signed URL is idempotent because version identity is
based on command, mode, seed, asset IDs, and checksums—not URL query data.

```json
{
  "commandId": "prepare-2026-08-24-a",
  "mode": "shuffle",
  "shuffleSeed": "program-rotation-7",
  "assets": [
    {
      "id": "station-ident",
      "sha256": "<64 lowercase hex characters>",
      "downloadUrl": "<short-lived signed HTTPS URL>"
    }
  ]
}
```

Start requires `X-Filler-Version`. An unprepared version returns 409. An active
session cannot switch versions; a new prepared version remains pending until
Stop and the next Start. The one exception is a filler Palazzo bound by itself
(`boundBy` `fallback`, below): an explicit Start always replaces it, so
Alcantara's Start with `X-Filler-Version` is unaffected by the fallback. Stop clears program queues and the filler binding but
does not stop Liquidsoap or disconnect Icecast.

## Storage and validation

The durable root defaults to `/var/lib/palazzo/fillers`. Program IDs are hashed
before they become directory names. Each immutable version contains a redacted
manifest, deterministic playlist, and normalized 44.1 kHz stereo MP3 artifacts
at the configured broadcast bitrate. Signed URLs and credentials are never
persisted or returned.

Palazzo downloads each source through the loopback media relay
([media-reads.md](media-reads.md)), which bounds it at 200 MiB (the store's own
bound is 512 MiB), verifies the source SHA-256, decodes
and normalizes it with ffmpeg, then validates codec, sample rate, channels, and
duration with ffprobe. The version directory is replaced atomically only after
every asset succeeds. Failure therefore preserves all known-good versions.
Deterministic shuffle is calculated once during preparation and persisted.

Liquidsoap watches `/run/palazzo/active-filler.m3u`. Its program source prefers
the live song queue and immediately falls back to the prepared local playlist;
the final `mksafe` boundary preserves the 24x7 Icecast transport when no version
is active. On restart Palazzo checks every artifact checksum and reconstructs
the watched playlist from the persisted active selection. Cleanup retains the three newest valid versions
and never removes the active version.

## Binding after a restart (gaulatti/palazzo#46)

The persisted selection (`.active-version`, in the `palazzo-fillers` volume) is
written atomically, and only by a Start. Without one (a Start never sent for
the program, or removed by Stop or by a failed Start), the radio used to run
with an empty filler playlist, so a failed song fell to silence. Palazzo now
binds a filler by itself, by this rule:

1. At boot, the version a Start last activated is restored while its selection
   is present and still validates (`boundBy` `restored`). With no selection, or
   an invalid one, Palazzo binds at boot only when the program was running
   when it went down: then the newest valid prepared version is bound at once
   (the rule in 2, `boundBy` `fallback`). A deliberately stopped radio binds
   nothing and sounds the same after a restart. "Running" is the
   `.automation-running` record in the same volume, written the first time a
   playback command or a Start puts automation in `running`, and removed by
   Stop or a failed Start (with the selection). Before this, the boot waited
   for the first song command to bind; on 2026-11-20 that command arrived
   before Palazzo could play, failed, and the filler stayed unbound.
2. When a program-scoped playback command moves the state to `running` with
   nothing bound, Palazzo binds the most recently prepared version whose
   manifest and artifact checksums validate (order by manifest `preparedAt`,
   then the greater name; a manifest without `preparedAt` is the oldest;
   `boundBy` `fallback`). A fallback is never written as a selection.
3. If none validates, nothing is bound, a log line says so, and
   `palazzo_filler_unbound_while_running` reports it. A version that fails
   validation is never bound.

While still running and unbound, later playback commands retry once a validated
version has been prepared. The bind is started and not awaited, so a song
start never waits on it; a failure is logged and never fails the command.
Alcantara's Start (`X-Filler-Version`) replaces a fallback-bound filler and
then stays immutable as above; a `restored` or `activate` binding is not
replaced.

`GET /v1/programs/{programId}/automation` reports it as the additive
`filler.boundBy` (`activate`, `restored`, `fallback`, or `null` when unbound);
`filler.activeVersion` and `filler.ready` are unchanged. Boot logs
`filler bound at boot: version=... boundBy=restored` (or `boundBy=fallback` from
the running record) or `no filler bound at boot`,
and a fallback binding logs `filler bound: version=... boundBy=fallback`.

## When the filler takes the air (gaulatti/alcantara#230)

The bound filler plays only when the rotation is really absent: no song, no
intro and no instant has been on air for `FILLER_HOLDOFF_SECONDS` (15 s,
`src/stream/liquidsoap-script.ts`). A song arriving takes the air at once.

- **Why 15 s.** Production since 2026-11-19: the longest instant was 11 s and
  the longest time from an accepted song command to the song on air was 1 s; an
  ordinary handoff passes about 4 s with nothing on. 15 s clears all of them
  with margin and is still short of dead air. Ordinary handoffs stay silent, as
  before; only a real absence brings the filler.
- **Handovers are hard cuts**, measured on the local runtime: a song replaces
  the filler within one 50 ms window, and when the song ends and the hold-off
  passes, the filler returns within one window. There is no fade, no overlap
  and no gap.
- **The filler resumes where it paused**, not from its first track.
- **Instants.** An instant counts as presence: it cuts the filler while it plays
  and restarts the hold-off, so a long instant with no song queued plays on its
  own, with no filler under it.
- **Live input** (gaulatti/palazzo#48). When `RTMP_URL` is set, a live RTMP
  feed on the air counts as presence too, so the filler never plays under a
  live show. The raw `live_input` reports whether the feed is on; the mix hears
  its `mksafe` wrapper (`live`), which is silent while the feed is off. With no
  `RTMP_URL` the script has no live input and nothing else counts.
- **Before this change** the filler could never take the air: `smooth_add`
  reports ready even with nothing on it, so the program fallback always chose
  the empty song chain, and a stalled rotation was silence (2026-11-20, about
  ten hours). The song chain is now gated on a song or an intro actually being
  ready (`songs_on_air`), and the filler on the hold-off (`filler_on_air`).
- `test/runtime/verify-station.sh` checks it on the real image:
  - the filler is heard with no song queued;
  - a song takes the air;
  - the filler resumes after the hold-off;
  - an instant followed by a song after an ordinary gap never puts the filler on air.

## Operations

`GET /metrics` adds bounded gauges for active/preparing state and a preparation
counter labeled only by `success`, `failure`, or `conflict`, plus the unlabeled
`palazzo_filler_unknown_modes_total`, exposed from 0. The unlabeled gauge
`palazzo_filler_unbound_while_running` is 1 while automation is requested
`running` and no validated filler is bound (a failed song is then silence), and
0 otherwise, including before any playback command or Start has set the
requested state after a boot. `palazzo_filler_active` is unchanged. Version, program, mode,
asset, URL, seed, and failure text never become labels. Lifecycle state exposes
only the active version, whether a validated binding exists, and how it was bound. Preparation
failure reasons are limited to checksum, download, size, decode, validation, or
generic preparation categories.

Compose and production persist the store in the Docker-managed
`palazzo-fillers` volume. The deploy workflow creates that volume idempotently
through Docker, so the unprivileged deployment user never needs to create or
write a host directory under `/opt`. Back up the named volume with the other
broadcast state; deleting it requires Alcantara to prepare versions again.
