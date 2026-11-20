# palazzo#47: the voice over RTMP mixed beside a program of songs, as
# Palazzo's script mixes its live input (`add`, gaulatti/palazzo#48). The
# songs are 20 s quiet tones in order; a thread skips the playing one at 33 s,
# so the run has natural song ends and a cut. Out as PCM on stdout.
settings.init.allow_root := true
settings.log.stdout := false
settings.log.level := 3
settings.log.file := true
settings.log.file.path := "/logs/songs.log"
settings.frame.duration := float_of_string(environment.get(default="0.02", "FRAME"))
settings.clock.latency := float_of_string(environment.get(default="0.1", "CLOCKLAT"))
voice = mksafe(input.rtmp(listen=true, "rtmp://0.0.0.0:1935/live/proof"))
songs = playlist(id="songs", mode="normal", reload_mode="never", "/media/list.m3u")
songs.on_track(synchronous=false, fun (m) -> log.important(label="songs", "song " ^ m["filename"]))
thread.run(delay=39., fun () -> begin log.important(label="songs", "skip"); songs.skip() end)
program = add(normalize=false, [mksafe(songs), voice])
output.file(
  flush=true,
  %ffmpeg(format="s16le", %audio(codec="pcm_s16le", samplerate=48000, channels=1)),
  "/dev/stdout",
  program
)
