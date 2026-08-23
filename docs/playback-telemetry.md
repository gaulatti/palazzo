# Playback telemetry

Palazzo exposes Liquidsoap's observed playback state. It does not infer a
start or end from REST command success, queue length, URL, or estimated
duration.

## Identity and ordering

- `PALAZZO_INSTANCE_ID` is the stable logical instance name. Set it explicitly
  in every deployed environment.
- `bootId` is generated whenever the Palazzo process starts.
- `sequence` increases monotonically within that boot.
- `playbackRequestId` is returned by `POST /song` and `POST /instant` and is
  attached to Liquidsoap request metadata.
- An SSE ID is `<bootId>:<sequence>`.

Consumers should fetch `GET /playback/state`, open `GET /playback/events`, and
persist the latest SSE ID. Reconnect with `Last-Event-ID`. If `bootId` changes
or the requested ID is outside the 512-event replay window, fetch a new state
snapshot before continuing.

## Cadence and bounded state

Liquidsoap keeps its most recent 128 lifecycle events. Palazzo keeps its most
recent 512 outward events. RMS and peak are sampled through a 100 ms engine
window and published at no more than 10 Hz. Position/status publishes at 1 Hz
and heartbeat at approximately 10 seconds. Track metadata is never used as a
Prometheus label.

## Failure semantics

A Telnet disconnect sets `telemetry.connected` to `false` and records
`staleSince`. Palazzo retains the last-known track and measurements because a
transport failure is not evidence that audio ended. After reconnect, a fresh
snapshot and the Liquidsoap journal reconcile lifecycle state. A lower engine
sequence is treated as a Liquidsoap restart.

Useful metrics:

- `palazzo_telemetry_connected`
- `palazzo_telemetry_sample_age_seconds`
- `palazzo_telemetry_poll_failures_total`
- `palazzo_telnet_reconnects_total`
- `palazzo_track_lifecycle_total{event="started|ended"}`
- `palazzo_sse_subscribers`

Alert on a disconnected bridge or growing sample age. Do not alert on a
last-known active track alone while the bridge is stale.

## Security boundary

Liquidsoap Telnet has no authentication and binds only to `127.0.0.1` inside
the container. The API, SSE, and metrics mappings also bind to host loopback in
Compose and deployment. Publish only the Icecast listener interface or place
it behind an approved reverse proxy.

## Runtime compatibility

The container pins the official Liquidsoap 2.4.5 multi-architecture image and
Node 22.22.0 image by immutable digest. Before changing either digest:

1. Run `npm test` and `npm run typecheck`.
2. Generate the script and validate it with the target Liquidsoap
   `liquidsoap --check` command.
3. Build the image for both `linux/amd64` and `linux/arm64`.
4. Play a known finite track and verify request ID, metadata, start, position,
   non-zero levels, end, idle state, SSE replay, and metrics.
5. Interrupt the command connection while a track plays and verify Palazzo
   marks telemetry stale without emitting a false `track.ended` event.

Existing callers remain compatible: the original control routes and `ok`
field are unchanged. Callers may ignore the added `playbackRequestId` and the
new `playback` member on `GET /status` until they adopt telemetry.
