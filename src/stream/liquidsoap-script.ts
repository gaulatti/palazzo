export interface LiquidsoapScriptOptions {
  telnetPort: number;
  icecastPort: number;
  icecastPassword: string;
  mount: string;
  streamName: string;
  genre: string;
  bitrate: number;
  fillerPlaylistPath: string;
  rtmpUrl?: string;
  /** How long Liquidsoap may take to resolve (download) one song request. */
  songRequestTimeoutMs: number;
}

function liqString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/** A Liquidsoap float literal for a duration in milliseconds, in seconds. */
function liqSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  return Number.isInteger(seconds) ? `${seconds}.` : String(seconds);
}

/**
 * Seconds with no song, intro or instant on air before the filler takes the
 * air (gaulatti/alcantara#230); see the script comment for the measurements.
 */
export const FILLER_HOLDOFF_SECONDS = 15;

export function buildLiquidsoapScript(
  options: LiquidsoapScriptOptions,
): string {
  const rtmpInput = options.rtmpUrl
    ? `live = mksafe(input.rtmp("${liqString(options.rtmpUrl)}"))`
    : "";
  const rtmpSource = options.rtmpUrl ? ", live" : "";

  return `#!/usr/bin/liquidsoap

settings.init.allow_root := true
settings.server.telnet := true
settings.server.telnet.bind_addr := "127.0.0.1"
settings.server.telnet.port := ${options.telnetPort}
settings.log.level := 3

events = ref([])
event_sequence = ref(0)
current_playing = ref(false)
current_request_id = ref("")
current_title = ref("")
current_artist = ref("")
current_cover_url = ref("")
current_url = ref("")
current_started_at = ref(0.)
current_intro_playing = ref(false)
current_intro_playback_id = ref("")
current_intro_parent_id = ref("")
current_intro_program_id = ref("")
current_intro_request_id = ref("")
current_intro_url = ref("")
current_intro_started_at = ref(0.)
armed_intro_parent_id = ref("")
icecast_connected = ref(false)

def metadata_value(key, meta) =
  list.assoc(default="", key, meta)
end

def remember_event(event_type, meta) =
  begin
    event_sequence := event_sequence() + 1
    body = json.stringify(compact=true, {
      sequence=event_sequence(),
      event_type=event_type,
      playback_request_id=metadata_value("palazzo_request_id", meta),
      playback_id=metadata_value("palazzo_playback_id", meta),
      parent_playback_id=metadata_value("palazzo_parent_playback_id", meta),
      program_id=metadata_value("palazzo_program_id", meta),
      title=metadata_value("title", meta),
      artist=metadata_value("artist", meta),
      cover_url=metadata_value("cover_url", meta),
      url=metadata_value("palazzo_url", meta),
      occurred_at=time()
    })
    events := [body, ...list.prefix(127, events())]
  end
end

# Song request queue (palazzo#42). A faithful copy of Liquidsoap 2.4.5's
# request.queue (src/libs/request.liq, non-native branch) whose next()
# resolves each popped request itself, with the explicit time limit, so a
# request that cannot be resolved is journalled once instead of being
# dropped silently. The resolution happens where request.dynamic would do it,
# in its feed task; the request it returns is already ready.
def palazzo_song_queue(~id, ~timeout) =
  # The limit is always given, so it is a plain float here.
  timeout = (timeout : float)
  initial_queue = ref([])
  queue = ref([])
  fetch = ref(fun () -> ())
  started = ref(false)

  def rec next() =
    if
      queue() != []
    then
      let [r, ...q] = queue()
      queue := q
      resolving_since = time()
      if
        request.resolve(r, timeout=timeout)
      then
        (r : request)
      else
        # Read the annotations before destroying the request. Reaching the
        # limit (within the protocol's early stop) is a timeout.
        meta = request.metadata(r)
        if
          time() - resolving_since >= timeout - 0.5
        then
          remember_event("song_request_timeout", meta)
        else
          remember_event("song_request_failed", meta)
        end
        request.destroy(r)
        next()
      end
    else
      null
    end
  end

  def push(r) =
    if
      started()
    then
      log.info(
        label=id,
        "Pushing #{r} on the queue."
      )
      queue := [...queue(), r]
      fn = fetch()
      fn()
    else
      log.info(
        label=id,
        "Pushing #{r} on the initial queue."
      )
      initial_queue := [...initial_queue(), r]
    end
  end

  def push_uri(uri) =
    r = request.create(uri)
    push(r)
  end

  s =
    request.dynamic(
      id=id,
      timeout=timeout,
      available={not list.is_empty(queue())},
      next
    )

  def add(r) =
    log.severe(
      label=s.id(),
      "Please use #{s.id()}.push instead of #{s.id()}.add()"
    )

    s.add(r)
  end

  def set_queue(q) =
    if started() then queue := q else initial_queue := q end
    s.set_queue([])
  end

  def get_queue() =
    [...s.queue(), ...initial_queue(), ...queue()]
  end

  def remove_request_id(rid) =
    if
      started()
    then
      queue := list.filter(fun (r) -> request.id(r) != rid, queue())
      inner_q = s.queue()
      filtered = list.filter(fun (r) -> request.id(r) != rid, inner_q)
      if
        list.length(filtered) < list.length(inner_q)
      then
        s.set_queue(filtered)
      end
    else
      initial_queue :=
        list.filter(fun (r) -> request.id(r) != rid, initial_queue())
    end
  end

  def remove(r) =
    remove_request_id(request.id(r))
  end

  s =
    s.{
      add=add,
      push=push.{uri=push_uri},
      length={list.length(queue()) + list.length(s.queue())},
      set_queue=set_queue,
      queue=get_queue,
      remove_request_id=remove_request_id,
      remove=remove
    }

  s.on_wake_up(
    synchronous=true,
    fun () ->
      begin
        started := true
        s.set_queue(initial_queue())
        initial_queue := []
      end
  )

  fetch := s.fetch

  def push_command(uri) =
    r = request.create(uri)
    push(r)
    "#{request.id(r)}"
  end

  s.register_command(
    description="Flush the queue and skip the current track",
    "flush_and_skip",
    fun (_) ->
      try
        s.set_queue([])
        s.skip()
        "Done."
      catch err do
        "Error while flushing and skipping source: #{err}"
      end
  )

  s.register_command(
    description="Push a new request in the queue.",
    usage="push <uri>",
    "push",
    push_command
  )

  def show_queue(_) =
    queue = s.queue()
    string.concat(
      separator=" ",
      list.map(fun (r) -> string(request.id(r)), queue)
    )
  end

  s.register_command(
    description="Display current queue content.",
    usage="queue",
    "queue",
    show_queue
  )

  def skip(_) =
    s.skip()
    "Done."
  end

  s.register_command(
    description="Skip current song.",
    usage="skip",
    "skip",
    skip
  )

  s.register_command(
    description="Remove a request from the queue.",
    usage="remove <rid>",
    "remove",
    fun (rid) ->
      begin
        remove_request_id(int_of_string(rid))
        "Done."
      end
  )

  s
end

songs_queue = palazzo_song_queue(id="songs", timeout=${liqSeconds(options.songRequestTimeoutMs)})
# Two song decks (gaulatti/palazzo#40). Deck "a" is the existing songs queue and stays open, so a song
# command plays exactly as before. An announced next song is resolved ahead of time and pushed to the idle
# deck behind a closed gate; a gated deck is not pulled, so the song waits at its first frame. The gate
# opens when the playing deck reaches remaining = the playing song's overlap (0 without one), so the next
# song starts on the following frame, or under the end of the current one.
next_queue = request.queue(id="songs_next")
song_volume = interactive.float("palazzo_song_volume", 1.)
deck_a_open = ref(true)
deck_b_open = ref(false)
active_deck = ref("a")
next_state = ref("none")
next_deck = ref("")
next_playback_id = ref("")
next_overlap = ref(0.)
next_generation = ref(0)
# A deck still playing (the tail of an overlapped song) cannot take the next song yet: the resolved
# request waits here until that deck's song ends.
next_pending = ref([])
# Request id of the announced song once pushed to its deck. A queue prefetches what is pushed to it, so a
# withdrawal must remove it by id: removing what queue() lists would miss a prefetched request.
next_rid = ref(-1)
deck_a_playing = ref(false)
deck_b_playing = ref(false)
# Request id of the song each deck has on air, for the end reasons of a command (gaulatti/palazzo#41).
deck_a_request = ref("")
deck_b_request = ref("")
# Armed 0.1 s before an overlap starts, so the limiter is already engaged on its first frame.
overlap_limiter_armed = ref(false)

# Per deck: loudness gain from liq_amplify (1.0 when absent), the song volume, and fades from
# liq_fade_in / liq_fade_out (none when absent).
def song_deck(queue, is_open) =
  gated = switch(track_sensitive=false, [({is_open()}, queue)])
  normalized = amplify(override="liq_amplify", 1., gated)
  controlled = amplify(override=null, song_volume, normalized)
  faded = fade.in(duration=0., track_sensitive=true, controlled)
  fade.out(duration=0., track_sensitive=true, faded)
end
deck_a = song_deck(songs_queue, deck_a_open)
deck_b = song_deck(next_queue, deck_b_open)

def remember_next_withdrawn(reason) =
  begin
    event_sequence := event_sequence() + 1
    body = json.stringify(compact=true, {
      sequence=event_sequence(),
      event_type="next_withdrawn",
      playback_request_id=next_playback_id(),
      playback_id=next_playback_id(),
      parent_playback_id="",
      program_id="",
      title="",
      artist="",
      cover_url="",
      url="",
      reason=reason,
      occurred_at=time()
    })
    events := [body, ...list.prefix(127, events())]
  end
end

def deck_queue(name) =
  if name == "b" then next_queue else songs_queue end
end

def set_deck_open(name, value) =
  if name == "b" then deck_b_open := value else deck_a_open := value end
end

def deck_playing(name) =
  if name == "b" then deck_b_playing() else deck_a_playing() end
end

def set_deck_playing(name, value) =
  if name == "b" then deck_b_playing := value else deck_a_playing := value end
end

def deck_request(name) =
  if name == "b" then deck_b_request() else deck_a_request() end
end

def set_deck_request(name, value) =
  if name == "b" then deck_b_request := value else deck_a_request := value end
end

# Journals why the song on a deck is about to end: replacement or operator, before a command cuts it, or
# cancel when that command failed (gaulatti/palazzo#41). Palazzo binds the reason to that playback.
def remember_track_skipped(request_id, reason) =
  begin
    event_sequence := event_sequence() + 1
    body = json.stringify(compact=true, {
      sequence=event_sequence(),
      event_type="track_skipped",
      playback_request_id=request_id,
      playback_id=request_id,
      parent_playback_id="",
      program_id="",
      title="",
      artist="",
      cover_url="",
      url="",
      reason=reason,
      occurred_at=time()
    })
    events := [body, ...list.prefix(127, events())]
  end
end

# Drops the announced song, if any, and reports why. Returns whether one was dropped.
def drop_next(reason) =
  # Once its gate has opened the announced song is on air: it is neither replaced nor withdrawn, and a
  # stop or song command ends it like any playing song.
  if next_state() == "none" or next_state() == "started" then
    false
  else
    begin
      next_generation := next_generation() + 1
      if next_state() == "queued" then
        q = deck_queue(next_deck())
        list.iter(fun (r) -> q.remove(r), q.queue())
        if next_rid() >= 0 then q.remove_request_id(next_rid()) end
      end
      next_rid := -1
      list.iter(fun (r) -> request.destroy(r), next_pending())
      next_pending := []
      # Never close a deck that is still playing: that would pause its song mid-way.
      if not deck_playing(next_deck()) then set_deck_open(next_deck(), false) end
      next_state := "none"
      overlap_limiter_armed := false
      remember_next_withdrawn(reason)
      true
    end
  end
end

def watch_deck(name, deck) =
  deck.on_track(
    synchronous=false,
    fun (meta) ->
      begin
        active_deck := name
        set_deck_playing(name, true)
        set_deck_request(name, metadata_value("palazzo_request_id", meta))
        if next_state() == "started" and next_deck() == name then
          next_state := "none"
        end
        current_playing := true
        current_request_id := metadata_value("palazzo_request_id", meta)
        current_title := metadata_value("title", meta)
        current_artist := metadata_value("artist", meta)
        current_cover_url := metadata_value("cover_url", meta)
        current_url := metadata_value("palazzo_url", meta)
        current_started_at := time()
        remember_event("track_started", meta)
      end
  )
  # Arms the overlap limiter just before an overlap.
  deck.on_position(
    position={next_overlap() + 0.1}, remaining=true, allow_partial=true, synchronous=true,
    fun (_, _) ->
      if next_state() == "queued" and next_deck() != name and active_deck() == name and next_overlap() > 0. then
        overlap_limiter_armed := true
      end
  )
  # Opens the announced song's gate at remaining = overlap on the deck that is playing.
  deck.on_position(
    position={next_overlap()}, remaining=true, allow_partial=true, synchronous=true,
    fun (_, _) ->
      if next_state() == "queued" and next_deck() != name and active_deck() == name then
        begin
          set_deck_open(next_deck(), true)
          # Marked on air here, in the frame the gate opens, so the overlap limiter is engaged from its start.
          set_deck_playing(next_deck(), true)
          next_state := "started"
        end
      end
  )
  deck.on_position(
    position={0.}, remaining=true, allow_partial=true, synchronous=false,
    fun (_, meta) ->
      begin
        set_deck_playing(name, false)
        overlap_limiter_armed := false
        # The announced song was waiting for this deck to finish its song: queue it now, gated.
        if next_state() == "waiting_deck" and next_deck() == name then
          begin
            set_deck_open(name, false)
            list.iter(fun (r) -> begin next_rid := request.id(r) deck_queue(name).push(r) end, next_pending())
            next_pending := []
            next_state := "queued"
          end
        end
        # The announced song is still resolving (or still waiting for a deck) when the playing song
        # ends: it is not ready in time, and the caller falls back to a song command.
        if (next_state() == "resolving" or next_state() == "waiting_deck") and active_deck() == name then
          ignore(drop_next("not_ready"))
        end
        remember_event("track_ended", meta)
        if metadata_value("palazzo_request_id", meta) == deck_request(name) then
          set_deck_request(name, "")
        end
        if metadata_value("palazzo_request_id", meta) == current_request_id() then
          current_playing := false
        end
      end
  )
end
watch_deck("a", deck_a)
watch_deck("b", deck_b)

songs_mixed = add(normalize=false, [deck_a, deck_b])
# While both decks are on air (an overlap), a limiter holds the sum under -1 dBTP. With one deck it is
# fully dry (wet 0 leaves the samples untouched), so a song plays exactly as before.
songs_limited = compress(
  threshold=-3., ratio=20., attack=1., release=200., knee=0., lookahead=0.,
  wet={if overlap_limiter_armed() or (deck_a_playing() and deck_b_playing()) then 1. else 0. end},
  songs_mixed
)
songs_rms = rms(id="songs_rms", duration=0.1, songs_limited)
get_song_rms = songs_rms.rms
songs = peak(id="songs_peak", duration=0.1, songs_rms)
get_song_peak = songs.peak

def active_deck_source() =
  if active_deck() == "b" then deck_b else deck_a end
end

# palazzo.prepare_next <playback id> <time limit seconds> <overlap seconds> <annotated uri>
server.register(
  namespace="palazzo",
  usage="prepare_next <playback id> <time limit seconds> <overlap seconds> <uri>",
  description="Resolve the announced next song and queue it behind a closed gate",
  "prepare_next",
  fun (arg) ->
    begin
      parts = string.split(separator=" ", arg)
      if list.length(parts) < 4 then
        "invalid"
      elsif next_state() == "started" then
        # The previous announcement has already started under the current song: too late to replace it.
        "too_late"
      else
        begin
          ignore(drop_next("replaced"))
          playback_id = list.nth(parts, 0)
          resolve_limit = float_of_string(default=0., list.nth(parts, 1))
          overlap = float_of_string(default=0., list.nth(parts, 2))
          uri = string.concat(separator=" ", list.tl(list.tl(list.tl(parts))))
          target = if active_deck() == "b" then "a" else "b" end
          if not deck_playing(target) then set_deck_open(target, false) end
          q = deck_queue(target)
          list.iter(fun (r) -> q.remove(r), q.queue())
          next_generation := next_generation() + 1
          generation = next_generation()
          next_state := "resolving"
          next_deck := target
          next_playback_id := playback_id
          next_overlap := overlap
          thread.run(fun () ->
            begin
              r = request.create(uri)
              ok = request.resolve(timeout=resolve_limit, r)
              if next_generation() == generation and next_state() == "resolving" then
                if ok then
                  if deck_playing(target) then
                    begin
                      next_pending := [r]
                      next_state := "waiting_deck"
                    end
                  else
                    begin
                      set_deck_open(target, false)
                      next_rid := request.id(r)
                      q.push(r)
                      next_state := "queued"
                    end
                  end
                else
                  begin
                    request.destroy(r)
                    ignore(drop_next("not_ready"))
                  end
                end
              else
                request.destroy(r)
              end
            end
          )
          "ok"
        end
      end
    end
)

# palazzo.withdraw_next <reason>: drops the announced song. Answers "withdrawn" or "none".
server.register(
  namespace="palazzo",
  usage="withdraw_next <reason>",
  description="Drop the announced next song",
  "withdraw_next",
  fun (reason) -> if drop_next(reason) then "withdrawn" else "none" end
)

# palazzo.reset_decks: before a song command or a stop. Drops the announcement, stops a song playing on
# deck b, and reopens deck a, so the existing songs commands act as they always have.
server.register(
  namespace="palazzo",
  usage="reset_decks",
  description="Return to the single song deck before a song command or stop",
  "reset_decks",
  fun (_) ->
    begin
      ignore(drop_next("flushed"))
      list.iter(fun (r) -> next_queue.remove(r), next_queue.queue())
      # Stop a song on deck b (the active song, or an announced one whose gate just opened). Its gate
      # stays open so the skip is pulled and the song ends now; closing it would freeze the song mid-way
      # and leave the deck marked as playing. Deck b's own end hook then clears its flag.
      if active_deck() == "b" or deck_b_playing() then
        next_queue.skip()
      else
        deck_b_open := false
      end
      overlap_limiter_armed := false
      deck_a_open := true
      active_deck := "a"
      next_overlap := 0.
      "ok"
    end
)

# palazzo.mark_ending <reason>: before a song command or a stop cuts what is on air, journals the reason
# for each deck's song at that instant (gaulatti/palazzo#41); "cancel" after a failed command.
server.register(
  namespace="palazzo",
  usage="mark_ending <replacement|operator|cancel>",
  description="Journal why the songs on air are about to end",
  "mark_ending",
  fun (reason) ->
    begin
      list.iter(
        fun (name) ->
          if deck_request(name) != "" then remember_track_skipped(deck_request(name), reason) end,
        ["a", "b"]
      )
      "ok"
    end
)

intros_queue = request.queue(id="intros", prefetch=1)
intros_per_item = amplify(1., intros_queue)
intros_faded = fade.in(
  override_duration="palazzo_fade_in",
  duration=0.25,
  track_sensitive=true,
  intros_per_item
)
intros_faded = fade.out(
  override_duration="palazzo_fade_out",
  duration=0.25,
  track_sensitive=true,
  intros_faded
)
intros_gated = source.available(
  track_sensitive=false,
  intros_faded,
  fun () ->
    current_playing() and
      current_request_id() == armed_intro_parent_id()
)
intros_rms = rms(id="intros_rms", duration=0.1, intros_gated)
get_intro_rms = intros_rms.rms
intros = peak(id="intros_peak", duration=0.1, intros_rms)
get_intro_peak = intros.peak

intros.on_track(
  synchronous=false,
  fun (meta) ->
    begin
      current_intro_playing := true
      current_intro_playback_id := metadata_value("palazzo_playback_id", meta)
      current_intro_parent_id := metadata_value("palazzo_parent_playback_id", meta)
      current_intro_program_id := metadata_value("palazzo_program_id", meta)
      current_intro_request_id := metadata_value("palazzo_request_id", meta)
      current_intro_url := metadata_value("palazzo_url", meta)
      current_intro_started_at := time()
      remember_event("intro_started", meta)
    end
)

intros.on_position(
  position=0., remaining=true, allow_partial=true, synchronous=false,
  fun (_, meta) ->
    begin
      remember_event("intro_ended", meta)
      if metadata_value("palazzo_playback_id", meta) == current_intro_playback_id() then
        current_intro_playing := false
        armed_intro_parent_id := ""
      end
    end
)

server.register(
  namespace="palazzo",
  description="Arm the prepared intro for one parent song",
  "arm_intro",
  fun (parent_id) ->
    begin
      armed_intro_parent_id := parent_id
      "ok"
    end
)

instants_requests = request.queue(id="instants")
instants_queue = mksafe(instants_requests)
instant_volume = interactive.float("palazzo_instant_volume", 1.)
instants_per_item = amplify(1., instants_queue)
instants_controlled = amplify(override=null, instant_volume, instants_per_item)
instants_rms = rms(id="instants_rms", duration=0.1, instants_controlled)
get_instant_rms = instants_rms.rms
instants = peak(id="instants_peak", duration=0.1, instants_rms)
get_instant_peak = instants.peak
filler_playlist = playlist(
  id="program_filler",
  mode="normal",
  reload=1,
  reload_mode="watch",
  "${liqString(options.fillerPlaylistPath)}"
)
# The filler takes the air only when the rotation is really absent: nothing
# (song, intro or instant) for FILLER_HOLDOFF_SECONDS (gaulatti/alcantara#230).
# Production since 2026-11-19: the longest instant was 11 s and the longest
# time from an accepted song command to the song on air was 1 s; an ordinary
# handoff passes about 4 s with nothing on. 15 s clears all of them with margin
# and is still short of dead air. A song arriving takes the air at once.
filler_last_on_air = ref(time())
thread.run(every=0.1, fun () ->
  if source.is_ready(songs) or source.is_ready(intros) or source.is_ready(instants_requests) then
    filler_last_on_air := time()
  end
)
filler = switch(
  id="filler_on_air",
  track_sensitive=false,
  [({time() - filler_last_on_air() > ${FILLER_HOLDOFF_SECONDS}.}, mksafe(filler_playlist))]
)
intro_duck_gain = interactive.float("palazzo_intro_duck_gain", 0.35)
ducked_songs = smooth_add(
  duration=0.25,
  p=intro_duck_gain,
  normal=songs,
  special=intros
)
# smooth_add reports ready even when no song and no intro is playing, so the
# fallback below never reached the filler and the air was silent whenever the
# song chain was empty (gaulatti/alcantara#230). The song chain takes the air
# only while a song or an intro is actually on it.
songs_on_air = switch(
  id="songs_on_air",
  track_sensitive=false,
  [({source.is_ready(songs) or source.is_ready(intros)}, ducked_songs)]
)
program_audio = fallback(track_sensitive=false, [songs_on_air, filler])
${rtmpInput}
radio = add(normalize=false, [program_audio, instants${rtmpSource}])
radio = mksafe(radio)
main_volume = interactive.float("palazzo_main_volume", 1.)
radio = amplify(override=null, main_volume, radio)
radio_rms = rms(id="radio_rms", duration=0.1, radio)
get_rms = radio_rms.rms
radio = peak(id="radio_peak", duration=0.1, radio_rms)
get_peak = radio.peak

def finite_level(value)
  if float.is_nan(value) or float.is_infinite(value) then 0. else value end
end

server.register(
  namespace="palazzo",
  description="Return the authoritative playback snapshot",
  "snapshot",
  fun (_) ->
    json.stringify(compact=true, {
      liquidsoap_sequence=event_sequence(),
      playing=current_playing(),
      playback_request_id=current_request_id(),
      title=current_title(),
      artist=current_artist(),
      cover_url=current_cover_url(),
      url=current_url(),
      started_at=current_started_at(),
      elapsed=finite_level(active_deck_source().elapsed()),
      remaining=finite_level(active_deck_source().remaining()),
      song_rms=finite_level(get_song_rms()),
      song_peak=finite_level(get_song_peak()),
      instant_rms=finite_level(get_instant_rms()),
      instant_peak=finite_level(get_instant_peak()),
      intro_playing=current_intro_playing(),
      intro_playback_id=current_intro_playback_id(),
      intro_parent_playback_id=current_intro_parent_id(),
      intro_program_id=current_intro_program_id(),
      intro_request_id=current_intro_request_id(),
      intro_url=current_intro_url(),
      intro_started_at=current_intro_started_at(),
      intro_rms=finite_level(get_intro_rms()),
      intro_peak=finite_level(get_intro_peak()),
      output_rms=finite_level(get_rms()),
      output_peak=finite_level(get_peak()),
      icecast_connected=icecast_connected(),
      sampled_at=time()
    })
)

server.register(
  namespace="palazzo",
  description="Return the bounded Liquidsoap lifecycle event journal",
  "events",
  fun (_) -> "[" ^ string.concat(separator=",", list.rev(events())) ^ "]"
)
icecast_output = output.icecast(
  id="icecast_output",
  %mp3(bitrate=${options.bitrate}),
  host="127.0.0.1", port=${options.icecastPort},
  password="${liqString(options.icecastPassword)}",
  mount="${liqString(options.mount)}",
  name="${liqString(options.streamName)}",
  genre="${liqString(options.genre)}",
  description="${liqString(options.streamName)}",
  icy_metadata=["song", "title", "artist", "cover_url"],
  radio
)

icecast_output.on_connect(
  synchronous=true,
  fun () -> icecast_connected := true
)
icecast_output.on_disconnect(
  synchronous=true,
  fun () -> icecast_connected := false
)
`;
}
