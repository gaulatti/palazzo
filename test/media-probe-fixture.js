// Explicit dependency data for tests of command ordering/idempotency only.
// Real ffprobe, transcoding and playback are exercised by runtime tests.
exports.mediaProbeResult = () => ({
  mediaType: 'audio', format: 'wav', codec: 'pcm_s16le',
  durationSeconds: 0.4, sampleRateHz: 44100, channels: 1, readablePacketBytes: 2048,
});
