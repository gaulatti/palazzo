# Appended by verify-deck-marks.sh to the station's own generated script (gaulatti/palazzo#75), whose
# Icecast output is replaced by output.dummy, so the real deck chain and its hooks run with no network.
# MODE picks the song and what happens to it on deck b (the announced song's deck):
#   duplicate  a 3 s song whose gate switch selects its queue twice: closed one frame after the song starts
#              and reopened the frame after, which is the production "Switch to songs_next" twice
#   natural    the same 3 s song, no second selection
#   truncated  a WAV whose header says 10 s but holds 1.5 s of audio
#   cueout     a 10 s song cued in at 0.5 s and out at 1.5 s
#   skip       a 10 s song skipped 1.5 s after it starts
#   stalled    the duplicate mark, then the gate closed again a few frames later and left closed: the deck
#              holds its request but stops producing audio (production 2026-11-28)
#   silent     the duplicate mark on a 10 s song of digital silence: the deck plays on but does not sound
#   stacked    two requests back to back in one deck's queue (deck a): a WAV whose header says 10 s but holds
#              1.5 s, so its end comes before its remaining time reaches 0, then the 3 s song (production
#              2026-11-28: the song after such an end on the same deck played silent)
#   silentstart  a 10 s song of digital silence with no duplicate mark: the check 1 s after the start ends it
#   faded      the 3 s song annotated liq_fade_in="2" and liq_fade_out="1": the song's own fades still apply
#   command    a song command (mark_ending, reset_decks, songs.flush_and_skip, songs.push) on the frame the
#              announced song's gate opens, before its track starts (production 2026-11-28): the announced
#              request must not play out with the commanded song stacked behind it on its deck
# It prints the deck's state and the song bus level mid-song (MID), the song bus level 2.6 s into the song
# (LATE) and the event journal at the end (EVENTS).
settings.log.stdout := true
harness_mode = environment.get(default="", "MODE")
harness_stage = ref(0)
deck_b.on_track(
  synchronous=true,
  fun (_) -> if harness_stage() == 0 and (harness_mode == "duplicate" or harness_mode == "stalled" or harness_mode == "silent") then harness_stage := 1 end
)
# radio is pulled every frame by the output, so the gate flips on consecutive frames of the same clock.
def harness_toggle() =
  if harness_stage() == 1 then
    deck_b_open := false
    harness_stage := 2
  elsif harness_stage() == 2 then
    deck_b_open := true
    harness_stage := 3
  elsif harness_stage() >= 3 and harness_stage() < 8 and harness_mode == "stalled" then
    harness_stage := harness_stage() + 1
  elsif harness_stage() == 8 then
    deck_b_open := false
    harness_stage := 9
  end
end
radio.on_frame(before=true, synchronous=true, harness_toggle)
def harness_journal() =
  "[" ^ string.concat(separator=",", list.rev(events())) ^ "]"
end
harness_uri =
  if harness_mode == "faded" then
    "annotate:liq_fade_in=\"2\",liq_fade_out=\"1\":/tmp/song.wav"
  elsif harness_mode == "truncated" then
    "/tmp/truncated.wav"
  elsif harness_mode == "cueout" then
    "annotate:liq_cue_in=\"0.5\",liq_cue_out=\"1.5\":/tmp/long.wav"
  elsif harness_mode == "skip" then
    "/tmp/long.wav"
  elsif harness_mode == "silent" or harness_mode == "silentstart" then
    "/tmp/silent.wav"
  else
    "/tmp/song.wav"
  end
def harness_song(uri) =
  r = request.create("annotate:palazzo_request_id=\"deck-marks\",title=\"T\",artist=\"A\":" ^ uri)
  if not request.resolve(r) then print("HARNESS the song did not resolve") end
  r
end
def harness_command(c) =
  print("HARNESS #{c} -> #{server.execute(c)}")
end
# The song starts about 2 s in, or later after what plays before it on its deck (stacked, command).
song_at = if harness_mode == "stacked" then 3.5 elsif harness_mode == "command" then 4. else 2. end
if harness_mode == "stacked" then
  thread.run(
    delay=2.,
    fun () ->
      begin
        first = request.create("annotate:palazzo_request_id=\"deck-marks-first\":/tmp/truncated.wav")
        ignore(request.resolve(first))
        songs_queue.push(first)
        songs_queue.push(harness_song("/tmp/song.wav"))
      end
  )
elsif harness_mode == "command" then
  begin
    commanded = ref(false)
    radio.on_frame(
      before=true,
      synchronous=true,
      fun () ->
        if not commanded() and next_state() == "started" then
          begin
            commanded := true
            r = harness_song("/tmp/song.wav")
            thread.run(
              fun () ->
                begin
                  harness_command("palazzo.mark_ending replacement")
                  harness_command("palazzo.reset_decks")
                  harness_command("songs.flush_and_skip")
                  songs_queue.push(r)
                end
            )
          end
        end
    )
    thread.run(
      delay=1.,
      fun () ->
        begin
          on_air = request.create("annotate:palazzo_request_id=\"deck-marks-on-air\":/tmp/song.wav")
          ignore(request.resolve(on_air))
          next_queue.push(on_air)
          deck_a_open := false
          deck_b_open := true
        end
    )
    thread.run(
      delay=2.,
      fun () -> harness_command("palazzo.prepare_next deck-marks-announced 5 0 annotate:palazzo_request_id=\"deck-marks-announced\":/tmp/long.wav")
    )
  end
else
  thread.run(
    delay=2.,
    fun () ->
      begin
        next_queue.push(harness_song(harness_uri))
        deck_b_open := true
      end
  )
end
if harness_mode == "skip" then thread.run(delay=3.5, fun () -> next_queue.skip()) end
thread.run(
  delay=song_at + 1.,
  fun () ->
    print("MID deck_b_playing=#{deck_b_playing()} current_playing=#{current_playing()} song_rms=#{get_song_rms()} journal=#{harness_journal()}")
)
thread.run(delay=song_at + 2.6, fun () -> print("LATE song_rms=#{get_song_rms()}"))
thread.run(
  delay=song_at + 5.,
  fun () ->
    begin
      print("EVENTS #{harness_journal()}")
      shutdown()
    end
)
