# Appended by verify-deck-marks.sh to the station's own generated script (gaulatti/palazzo#75), whose
# Icecast output is replaced by output.dummy, so the real deck chain and its hooks run with no network.
# MODE picks the song and what happens to it on deck b (the announced song's deck):
#   duplicate  a 3 s song whose gate switch selects its queue twice: closed one frame after the song starts
#              and reopened the frame after, which is the production "Switch to songs_next" twice
#   natural    the same 3 s song, no second selection
#   truncated  a WAV whose header says 10 s but holds 1.5 s of audio
#   cueout     a 10 s song cued in at 0.5 s and out at 1.5 s
#   skip       a 10 s song skipped 1.5 s after it starts
# It prints the deck's state mid-song (MID) and the event journal at the end (EVENTS).
settings.log.stdout := true
harness_mode = environment.get(default="", "MODE")
harness_stage = ref(0)
deck_b.on_track(
  synchronous=true,
  fun (_) -> if harness_stage() == 0 and harness_mode == "duplicate" then harness_stage := 1 end
)
# radio is pulled every frame by the output, so the gate flips on consecutive frames of the same clock.
def harness_toggle() =
  if harness_stage() == 1 then
    deck_b_open := false
    harness_stage := 2
  elsif harness_stage() == 2 then
    deck_b_open := true
    harness_stage := 3
  end
end
radio.on_frame(before=true, synchronous=true, harness_toggle)
def harness_journal() =
  "[" ^ string.concat(separator=",", list.rev(events())) ^ "]"
end
harness_uri =
  if harness_mode == "truncated" then
    "/tmp/truncated.wav"
  elsif harness_mode == "cueout" then
    "annotate:liq_cue_in=\"0.5\",liq_cue_out=\"1.5\":/tmp/long.wav"
  elsif harness_mode == "skip" then
    "/tmp/long.wav"
  else
    "/tmp/song.wav"
  end
thread.run(
  delay=2.,
  fun () ->
    begin
      r = request.create("annotate:palazzo_request_id=\"deck-marks\",title=\"T\",artist=\"A\":" ^ harness_uri)
      if not request.resolve(r) then print("HARNESS the song did not resolve") end
      next_queue.push(r)
      deck_b_open := true
    end
)
if harness_mode == "skip" then thread.run(delay=3.5, fun () -> next_queue.skip()) end
thread.run(
  delay=3.,
  fun () ->
    print("MID deck_b_playing=#{deck_b_playing()} current_playing=#{current_playing()} journal=#{harness_journal()}")
)
thread.run(
  delay=7.,
  fun () ->
    begin
      print("EVENTS #{harness_journal()}")
      shutdown()
    end
)
