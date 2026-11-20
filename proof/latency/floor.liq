# palazzo#47: Liquidsoap's own floor. Raw 48 kHz mono PCM in on stdin, the
# same audio out on stdout, nothing else in the path. FRAME and MAXBUF come
# from the environment so each setting is one run.
settings.init.allow_root := true
settings.log.stdout := false
settings.log.level := 3
settings.log.file := true
settings.log.file.path := "/logs/floor.log"
settings.frame.duration := float_of_string(environment.get(default="0.02", "FRAME"))
settings.clock.latency := float_of_string(environment.get(default="0.1", "CLOCKLAT"))
s = input.ffmpeg(
  format="s16le",
  int_args=[("sample_rate", 48000)],
  string_args=[("ch_layout", "mono")],
  max_buffer=float_of_string(environment.get(default="5.0", "MAXBUF")),
  self_sync=true,
  "pipe:0"
)
output.file(
  fallible=true,
  flush=true,
  %ffmpeg(format="s16le", %audio(codec="pcm_s16le", samplerate=48000, channels=1)),
  "/dev/stdout",
  s
)
