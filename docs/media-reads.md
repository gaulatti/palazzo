# Media reads

Palazzo reads every song, intro, instant, announced next song, preflight probe
and filler source through one in-process media relay. Liquidsoap, ffprobe and
the filler download are never given a supplied media URL; they are given a
relay address on `127.0.0.1`, and the supplied URL stays in the `palazzo_url`
annotation, so playback events report it unchanged.

## What the relay does

- It listens on `127.0.0.1` only, on an ephemeral port inside the container.
  Neither Compose nor the deploy publishes it.
- Each media URL gets an unguessable token, valid until the request's own
  deadline: the song request time limit (`SONG_REQUEST_TIMEOUT_MS`) for songs,
  intros and instants, the announced song's resolve limit for the next song,
  `PREFLIGHT_TIMEOUT_MS` for preflight, and 30 seconds for a filler source.
  Only `GET` and `HEAD` on `/m/<token>` are served; anything else is `404`.
  Tokens never appear in logs, metric labels or events.
- On every request it checks the URL again: `http` or `https`, no user name or
  password, and every address the host resolves to must be public (the same
  address rule as Alcantara's outbound requests). The connection goes to the
  checked address only, keeping the host name for TLS and the `Host` header.
- It follows no redirect, accepts only an audio type (`audio/*`,
  `application/ogg`) or a generic binary type (`application/octet-stream`,
  `binary/octet-stream`), stops at 200 MiB (Alcantara's upload limit; this also
  bounds filler sources), and forwards `Range`, so a tool can seek as before.
- Nothing is written to disk on the playout path; Liquidsoap keeps its own
  download behaviour.

## Failures

A refused or failed read fails exactly as an unreachable URL does: preflight
reports `unreachable`, a song command answers that the asset is not ready, an
announced song is not queued (`not_ready`), and a request Liquidsoap cannot
resolve emits `playout.request_failed` with reason `other`. A filler
preparation fails with `download-failed`.

`palazzo_media_fetch_total{path,result}` counts every read and refusal. `path`
is `song`, `intro`, `instant`, `next`, `preflight` or `filler`; `result` is
`ok`, `invalid_url`, `scheme`, `address`, `dns`, `redirect`, `http_status`,
`content_type`, `too_large`, `timeout` or `network`. Every series starts at
zero. A sustained rise of `address` or `dns` for a path means media is being
supplied from a host Palazzo will not read.

## Local stacks

Local Compose serves media from private addresses, so `compose.yml` sets
`PALAZZO_MEDIA_ALLOW_PRIVATE=true`, which lets the relay read them. Palazzo
refuses to start with that setting when `NODE_ENV=production`, and no deploy
path sets it.
