# Immutable radio filler preparation

Palazzo prepares versioned, program-scoped radio filler before a broadcast
session starts. Alcantara owns the private commands; Palazzo owns downloads,
validation, durable local storage, and Liquidsoap playback. Once preparation
finishes, playback does not depend on Alcantara, object storage, signed URLs, or
network availability.

## Private API

All routes require the same bearer token and exact `PROGRAM_ID` as the
broadcast lifecycle API.

| Method | Path | Purpose |
| --- | --- | --- |
| `PUT` | `/v1/programs/{programId}/fillers/{version}` | Prepare or idempotently inspect an immutable version |
| `GET` | `/v1/programs/{programId}/fillers/{version}` | Read bounded readiness or failure state |

`PUT` also requires `Idempotency-Key`; the JSON `commandId` must match it.
`assets` contains one to 100 `{id, sha256, downloadUrl}` objects. `mode` is
`ordered` or `shuffle`; shuffle also requires a bounded `shuffleSeed`.
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
Stop and the next Start. Stop clears program queues and the filler binding but
does not stop Liquidsoap or disconnect Icecast.

## Storage and validation

The durable root defaults to `/var/lib/palazzo/fillers`. Program IDs are hashed
before they become directory names. Each immutable version contains a redacted
manifest, deterministic playlist, and normalized 44.1 kHz stereo MP3 artifacts
at the configured broadcast bitrate. Signed URLs and credentials are never
persisted or returned.

Palazzo bounds each download at 512 MiB, verifies the source SHA-256, decodes
and normalizes it with ffmpeg, then validates codec, sample rate, channels, and
duration with ffprobe. The version directory is replaced atomically only after
every asset succeeds. Failure therefore preserves all known-good versions.
Deterministic shuffle is calculated once during preparation and persisted.

Liquidsoap watches `/run/palazzo/active-filler.m3u`. Its program source prefers
the live song queue and immediately falls back to the prepared local playlist;
the final `mksafe` boundary preserves the 24x7 Icecast transport when no version
is active. On restart Palazzo checks every artifact checksum and reconstructs
the watched playlist from the persisted active selection. Invalid selections
fail closed to safe silence. Cleanup retains the three newest valid versions
and never removes the active version.

## Operations

`GET /metrics` adds bounded gauges for active/preparing state and a preparation
counter labeled only by `success`, `failure`, or `conflict`. Version, program,
asset, URL, seed, and failure text never become labels. Lifecycle state exposes
only the active version and whether a validated binding exists. Preparation
failure reasons are limited to checksum, download, size, decode, validation, or
generic preparation categories.

Compose and production persist the store in the Docker-managed
`palazzo-fillers` volume. The deploy workflow creates that volume idempotently
through Docker, so the unprivileged deployment user never needs to create or
write a host directory under `/opt`. Back up the named volume with the other
broadcast state; deleting it requires Alcantara to prepare versions again.
