# palazzo#47: the voice's ingest leg alone. AAC/FLV over RTMP into input.rtmp
# (listening, as Palazzo's RTMP_URL does), the same audio out on stdout as PCM.
settings.init.allow_root := true
settings.log.stdout := false
settings.log.level := 3
settings.log.file := true
settings.log.file.path := "/logs/rtmp.log"
settings.frame.duration := float_of_string(environment.get(default="0.02", "FRAME"))
settings.clock.latency := float_of_string(environment.get(default="0.1", "CLOCKLAT"))
s = input.rtmp(listen=true, "rtmp://0.0.0.0:1935/live/proof")
output.file(
  fallible=true,
  flush=true,
  %ffmpeg(format="s16le", %audio(codec="pcm_s16le", samplerate=48000, channels=1)),
  "/dev/stdout",
  s
)
