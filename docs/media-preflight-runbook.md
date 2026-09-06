# Media preflight runbook

## Normal operation

Submit upcoming assets with `PUT /v1/programs/{programId}/playback/preflight`
inside the configured lookahead. Confirm each required song is `ready` and its
`expiresAt` is later than its expected air time. The endpoint never writes to
Liquidsoap queues and cannot interrupt the active item.

Palazzo retains at most `PREFLIGHT_CACHE_ENTRIES` readiness records. Repeating
the same playback ID and URL before expiry reuses the probe. A changed URL or
expired state is probed again. Media bytes are not cached.

## Quarantine and fallback

Reason classes are closed: `outside_lookahead`, `missing`, `unreachable`,
`timeout`, `corrupt`, `unsupported_media`, and `invalid_metadata`.

- A quarantined song is rejected before any queue mutation. Repair or replace
  it at the scheduling owner, then submit a new URL or wait for expiry.
- A quarantined intro falls back to song-only playback. Correlate
  `preflight.failed`, `intro.failed`, and `playout.fallback` by playback IDs.
- Preflight never skips, flushes, or pushes active/queued Liquidsoap material.

Investigate elevated `palazzo_media_preflight_total{result="failed",...}` by
reason. IDs and URLs are intentionally absent from metrics; use the
authenticated readiness endpoint and the scheduling owner together.

## Consumer reconciliation

Persist the latest SSE ID. Reconnect with `Last-Event-ID`, but always consume
the leading snapshot first. If `bootId` changed, the ID is outside the 512
event window, or sequence values are discontinuous, discard locally inferred
playback and replace it with that snapshot. Resume applying transitions only
after reconciliation.

The durable sequence file must live on Palazzo's persistent volume and remain
mode 0600. If startup reports that the event sequence journal is unavailable,
repair the mount/ownership; do not delete the cursor while consumers rely on
gap detection.

## Verification after configuration changes

1. Probe known-valid, missing, corrupt, and deliberately delayed fixtures.
2. Confirm reason classes and checked/expiry timestamps are deterministic.
3. Submit more assets than concurrency and cache bounds permit; confirm the
   request is rejected or bounded and the active track is uninterrupted.
4. Stop and restart Palazzo, reconnect with the prior SSE ID, and confirm the
   new boot snapshot has a higher sequence.
5. Scrape metrics and verify no playback IDs, URLs, credentials, or free-form
   errors appear.
