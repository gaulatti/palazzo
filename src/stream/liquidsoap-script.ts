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
 * Seconds with no song, intro, instant or live input on air before the filler
 * takes the air (gaulatti/alcantara#230); see the script comment for the measurements.
 */
export const FILLER_HOLDOFF_SECONDS = 15;

/**
 * Seconds before the playing song's end that an announced spot is pushed to the instants queue
 * (gaulatti/palazzo#50), so it is on air as the song ends; pushed at the end it starts about 0.14 s late.
 */
export const BUMPER_LEAD_SECONDS = "0.12";

export function buildLiquidsoapScript(
  options: LiquidsoapScriptOptions,
): string {
  const rtmpInput = options.rtmpUrl
    ? `live_input = input.rtmp("${liqString(options.rtmpUrl)}")
live = mksafe(live_input)`
    : "";
  const rtmpSource = options.rtmpUrl ? ", live" : "";
  const livePresence = options.rtmpUrl ? " or source.is_ready(live_input)" : "";
  const liveOnAir = options.rtmpUrl ? "source.is_ready(live_input)" : "false";

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
# Liquidsoap request id (rid) of the last track each deck journalled as started (gaulatti/palazzo#75).
deck_a_started_rid = ref("")
deck_b_started_rid = ref("")
# Armed 0.1 s before an overlap starts, so the limiter is already engaged on its first frame.
overlap_limiter_armed = ref(false)

# Instants (spots and clips fired by hand) play from this queue, mixed over the program.
instants_requests = request.queue(id="instants")
# Puts the station name on the stream title; set once the mix exists (gaulatti/palazzo#54).
station_title = ref(fun () -> ())
# A spot announced with the next song (gaulatti/palazzo#50). It is resolved ahead of time like the song;
# when the playing song ends it plays on the instants queue, and the song's gate opens at the spot's own
# end, so the song follows the spot with no gap and no fixed wait. A spot never holds the song: one not
# resolved by the song's end, not on air within 1 s, or on air for more than 60 s is dropped and the gate
# opens at once. bumper_state: none, resolving, ready (resolved, waiting for the end) or playing.
bumper_state = ref("none")
bumper_playback_id = ref("")
bumper_pending = ref([])
# The same spot resolved again with its measured cue-out (palazzo.recue_bumper): when there is one, it goes on
# air instead of bumper_pending, which was resolved whole before the spot was measured.
bumper_recued = ref([])
bumper_generation = ref(0)
bumper_on_air = ref(false)
# Request id of the spot once pushed to the instants queue, and the playback id of one dropped there as
# not on air in time: it is removed from the queue, and skipped if it still comes on air, so nothing of it
# plays over the song.
bumper_rid = ref(-1)
bumper_dropped_id = ref("")
# The announcement a spot on air belongs to (its next_generation when the spot started). A song command
# or a new announcement while the spot plays changes next_generation: the spot then plays out but no
# longer opens a gate, so a song announced after the command never starts under it (P0 2026-11-21).
bumper_next_generation = ref(-1)

def remember_bumper_result(result) =
  begin
    event_sequence := event_sequence() + 1
    body = json.stringify(compact=true, {
      sequence=event_sequence(),
      event_type="bumper_result",
      playback_request_id=bumper_playback_id(),
      playback_id=bumper_playback_id(),
      parent_playback_id=next_playback_id(),
      program_id="",
      title="",
      artist="",
      cover_url="",
      url="",
      reason=result,
      occurred_at=time()
    })
    events := [body, ...list.prefix(127, events())]
  end
end

# Drops a spot that is not on air yet (resolving or ready); one already playing plays out.
def drop_bumper() =
  if bumper_state() != "playing" then
    begin
      bumper_generation := bumper_generation() + 1
      list.iter(fun (r) -> request.destroy(r), bumper_pending())
      bumper_pending := []
      list.iter(fun (r) -> request.destroy(r), bumper_recued())
      bumper_recued := []
      bumper_state := "none"
    end
  end
end

# Per deck: loudness gain from liq_amplify (1.0 when absent) and the song volume. A song's cue points
# (liq_cue_in / liq_cue_out) are applied by request resolution itself in Liquidsoap 2.4, so the deck plays
# from cue-in to cue-out and its remaining time and every position hook below are on that trimmed clock
# (gaulatti/palazzo#53). No fade is applied: the fade operators below have no duration and no override.
# The gate comes last, after the fades (production 2026-11-28). Each time the gate switch selects its queue
# again it starts a track (gaulatti/palazzo#75), and a track-sensitive fade.out under the gate read the end
# of that partial track as the song's end: its end hook, with 221 s still to play, ran after its own reset
# for the new track and left its gain at 0 for the rest of the song. The deck held its request and its
# clock ran, but it played silence while Palazzo reported the song playing. Above the fades, a reselection's
# mark never reaches them. The gate's log names its child after the queue ("Switch to songs_next_faded").
# The deck's peak is measured for the check after a duplicate mark (below).
def song_deck(queue, is_open) =
  normalized = amplify(override="liq_amplify", 1., queue)
  controlled = amplify(override=null, song_volume, normalized)
  faded = fade.in(duration=0., track_sensitive=true, controlled)
  faded = fade.out(id="#{source.id(queue)}_faded", duration=0., track_sensitive=true, faded)
  gated = switch(track_sensitive=false, [({is_open()}, faded)])
  peak(duration=0.5, gated)
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

def deck_is_open(name) =
  if name == "b" then deck_b_open() else deck_a_open() end
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

def deck_started_rid(name) =
  if name == "b" then deck_b_started_rid() else deck_a_started_rid() end
end

def set_deck_started_rid(name, value) =
  if name == "b" then deck_b_started_rid := value else deck_a_started_rid := value end
end

# gaulatti/palazzo#75: a deck's gate switch can select its queue a second time a few milliseconds after the
# first (production, 2026-11-27: "Switch to songs_next" twice, 4 ms apart). Each selection starts a track,
# so the song gets a second track mark while the same request goes on playing. The allow_partial hooks below
# would read the end of that partial first track as the song's end: track_ended was journalled 22 ms after
# track_started and the deck released. Such a mark is not an end: the deck's queue is still playing the
# request that "ended", and the remaining time Liquidsoap hands the hook (pos) is still above the hook's
# point. A real end (natural, cue-out, a truncated file), a skip or a stop leaves 0 remaining, or another
# request current, so it is never taken for a duplicate. Measured on Liquidsoap 2.4.5.
def deck_mark_is_duplicate(name, pos, point, meta) =
  rid = metadata_value("rid", meta)
  current = deck_queue(name).current()
  if rid == "" or pos <= point + 0.5 or not null.defined(current) then
    false
  else
    string(request.id(null.get(current))) == rid
  end
end

# Opens the announced song's gate: it starts on the next frame, marked on air in this same frame so the
# overlap limiter is engaged from its start.
def open_next_gate() =
  begin
    set_deck_open(next_deck(), true)
    set_deck_playing(next_deck(), true)
    next_state := "started"
  end
end

# The check after a duplicate track mark (production 2026-11-28). An ignored track end must not leave a deck
# reported playing while it is silent: 1 s after the mark the deck must still hold the request, its queue's
# remaining time must have gone down, and the deck must sound above -60 dBFS (relative to the song volume;
# a song volume at 0 counts as sounding). Then the mark is journalled "played". Otherwise it is journalled
# "ended" and the song ends as a real end: the gate is opened (a stalled deck may be closed, and a closed
# deck is not pulled) and the queue skipped, so the deck's own end hooks journal track_ended and hand over to
# the announced song as at any end. A deck still marked playing 0.6 s after that (its request gone, so
# there is nothing to skip) is released here. Only the check after a deck's latest mark acts.
deck_a_mark_check = ref(0)
deck_b_mark_check = ref(0)

def deck_mark_check(name) =
  if name == "b" then deck_b_mark_check() else deck_a_mark_check() end
end

def set_deck_mark_check(name, value) =
  if name == "b" then deck_b_mark_check := value else deck_a_mark_check := value end
end

def remember_duplicate_mark(result, meta) =
  begin
    event_sequence := event_sequence() + 1
    body = json.stringify(compact=true, {
      sequence=event_sequence(),
      event_type="duplicate_mark",
      playback_request_id=metadata_value("palazzo_request_id", meta),
      playback_id=metadata_value("palazzo_playback_id", meta),
      parent_playback_id="",
      program_id=metadata_value("palazzo_program_id", meta),
      title="",
      artist="",
      cover_url="",
      url="",
      reason=result,
      occurred_at=time()
    })
    events := [body, ...list.prefix(127, events())]
  end
end

def deck_holds(name, rid) =
  current = deck_queue(name).current()
  if null.defined(current) then string(request.id(null.get(current))) == rid else false end
end

def release_stalled_deck(name, rid, meta) =
  if deck_started_rid(name) == rid and deck_playing(name) then
    begin
      log.important(label="deck_#{name}", "request #{rid} was still marked playing after its skip: its end is journalled here")
      set_deck_playing(name, false)
      overlap_limiter_armed := false
      if next_state() == "queued" and next_deck() != name and active_deck() == name then
        begin
          drop_bumper()
          open_next_gate()
        end
      end
      remember_event("track_ended", meta)
      if metadata_value("palazzo_request_id", meta) == deck_request(name) then
        set_deck_request(name, "")
      end
      if metadata_value("palazzo_request_id", meta) == current_request_id() then
        current_playing := false
      end
    end
  end
end

def check_after_duplicate_mark(name, deck, rid, pos, meta) =
  generation = deck_mark_check(name) + 1
  set_deck_mark_check(name, generation)
  thread.run(delay=1., fun () ->
    if deck_mark_check(name) == generation and deck_started_rid(name) == rid and deck_playing(name) then
      begin
        held = deck_holds(name, rid)
        left = deck_queue(name).remaining()
        level = deck.peak()
        volume = song_volume()
        sounding = volume <= 0. or level > 0.001 * volume
        if held and left > 0. and left < pos - 0.5 and sounding then
          begin
            log.important(label="deck_#{name}", "request #{rid} still plays 1 s after a duplicate track mark (#{left} s left, peak #{level})")
            remember_duplicate_mark("played", meta)
          end
        else
          begin
            log.important(label="deck_#{name}", "request #{rid} stopped after a duplicate track mark (held #{held}, #{left} s left of #{pos}, peak #{level}): ended as a real end")
            remember_duplicate_mark("ended", meta)
            # A closed gate is opened first and the skip sent a frame or so later: the reopening is itself a
            # duplicate mark, and a skip in that same frame would end the song twice.
            if held and deck_is_open(name) then
              deck_queue(name).skip()
            elsif held then
              begin
                set_deck_open(name, true)
                thread.run(delay=0.1, fun () -> if deck_holds(name, rid) then deck_queue(name).skip() end)
              end
            end
            thread.run(delay=0.6, fun () -> release_stalled_deck(name, rid, meta))
          end
        end
      end
    end
  )
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
      # A spot waiting with the song goes with it; one the song was not ready for is journalled.
      if bumper_state() == "resolving" or bumper_state() == "ready" then
        begin
          drop_bumper()
          if reason == "not_ready" then remember_bumper_result("dropped_unresolved") end
        end
      end
      remember_next_withdrawn(reason)
      true
    end
  end
end

# Gives the air to the announced song the spot was played for, and only to it.
def open_gate_after_spot() =
  if next_state() == "queued" and next_generation() == bumper_next_generation() then open_next_gate() end
end

# Puts the ready spot on air; the announced song waits for its end. A spot not on air within 1 s, or on
# air for more than 60 s, gives the air to the song.
def start_bumper() =
  begin
    bumper_state := "playing"
    bumper_next_generation := next_generation()
    bumper_on_air := false
    generation = bumper_generation()
    # The spot resolved with its cue-out, when it is ready, replaces the one resolved whole.
    if list.length(bumper_recued()) > 0 then
      begin
        list.iter(fun (r) -> request.destroy(r), bumper_pending())
        bumper_pending := bumper_recued()
        bumper_recued := []
      end
    end
    list.iter(fun (r) -> begin bumper_rid := request.id(r) instants_requests.push(r) end, bumper_pending())
    bumper_pending := []
    # Not on air within 1 s: the spot failed and the song takes the air.
    thread.run(delay=1., fun () ->
      if bumper_generation() == generation and bumper_state() == "playing" and not bumper_on_air() then
        begin
          bumper_state := "none"
          bumper_dropped_id := bumper_playback_id()
          instants_requests.remove_request_id(bumper_rid())
          remember_bumper_result("dropped_failed")
          open_gate_after_spot()
        end
      end
    )
    # On air for more than 60 s: the spot is cut and the song takes the air.
    thread.run(delay=60., fun () ->
      if bumper_generation() == generation and bumper_state() == "playing" then
        begin
          bumper_state := "none"
          bumper_on_air := false
          remember_bumper_result("dropped_late")
          instants_requests.skip()
          open_gate_after_spot()
        end
      end
    )
  end
end

def watch_deck(name, deck) =
  deck.on_track(
    synchronous=false,
    fun (meta) ->
      begin
      rid = metadata_value("rid", meta)
      # A second track mark on the request already started on this deck is the same song going on
      # (gaulatti/palazzo#75): it is not journalled again, and its start time and state are kept.
      if rid != "" and rid == deck_started_rid(name) then
        log.important(label="deck_#{name}", "request #{rid} got a second track mark: the same song goes on, not a new start")
      else
      begin
        set_deck_started_rid(name, rid)
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
      end
      end
  )
  # Arms the overlap limiter just before an overlap.
  deck.on_position(
    position={next_overlap() + 0.1}, remaining=true, allow_partial=true, synchronous=true,
    fun (pos, meta) ->
      if not deck_mark_is_duplicate(name, pos, next_overlap() + 0.1, meta) and next_state() == "queued" and next_deck() != name and active_deck() == name and next_overlap() > 0. and bumper_state() == "none" then
        overlap_limiter_armed := true
      end
  )
  # Opens the announced song's gate at remaining = overlap on the deck that is playing. With a spot
  # announced there is no overlap: the spot plays first (below).
  deck.on_position(
    position={next_overlap()}, remaining=true, allow_partial=true, synchronous=true,
    fun (pos, meta) ->
      if not deck_mark_is_duplicate(name, pos, next_overlap(), meta) and next_state() == "queued" and next_deck() != name and active_deck() == name and bumper_state() == "none" then
        open_next_gate()
      end
  )
  # BUMPER_LEAD_SECONDS before the playing song's end, with the announced song queued: a ready spot is
  # pushed then, so it is on air as the song ends (pushed at the end, it starts about 0.14 s late,
  # measured), and the song waits for the spot's end. At the end itself: a spot still resolving is dropped
  # and the song starts now, as does a song whose gate is still closed (a spot dropped after the overlap
  # point).
  deck.on_position(
    position={${BUMPER_LEAD_SECONDS}}, remaining=true, allow_partial=true, synchronous=true,
    fun (pos, meta) ->
      if not deck_mark_is_duplicate(name, pos, ${BUMPER_LEAD_SECONDS}, meta) and next_state() == "queued" and next_deck() != name and active_deck() == name and bumper_state() == "ready" then
          start_bumper()
      end
  )
  deck.on_position(
    position={0.}, remaining=true, allow_partial=true, synchronous=true,
    fun (pos, meta) ->
      if not deck_mark_is_duplicate(name, pos, 0., meta) and next_state() == "queued" and next_deck() != name and active_deck() == name then
        if bumper_state() == "resolving" then
          begin
            drop_bumper()
            remember_bumper_result("dropped_unresolved")
            open_next_gate()
          end
        elsif bumper_state() == "ready" then
          # Resolved in the last BUMPER_LEAD_SECONDS: on air now, slightly late.
          start_bumper()
        elsif bumper_state() == "none" then
          open_next_gate()
        end
      end
  )
  deck.on_position(
    position={0.}, remaining=true, allow_partial=true, synchronous=false,
    fun (pos, meta) ->
      # The end of the partial track before a duplicate mark is not the song's end (gaulatti/palazzo#75):
      # nothing is journalled and the deck keeps its song. pos is the remaining time when the mark came, so
      # this holds however late the callback runs.
      begin
      rid = metadata_value("rid", meta)
      if deck_mark_is_duplicate(name, pos, 0., meta) then
        log.important(label="deck_#{name}", "ignored a track end on request #{rid} with #{pos} s still to play: a duplicate track mark, not the song's end")
        check_after_duplicate_mark(name, deck, rid, pos, meta)
      else
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

# palazzo.prepare_bumper <playback id> <time limit seconds> <annotated uri>: resolves a spot to play
# before the announced next song (gaulatti/palazzo#50). Sent after prepare_next; answers "none" when no
# song is announced or it has already started, "invalid" on a malformed command, else "ok".
server.register(
  namespace="palazzo",
  usage="prepare_bumper <playback id> <time limit seconds> <uri>",
  description="Resolve a spot to play before the announced next song",
  "prepare_bumper",
  fun (arg) ->
    begin
      parts = string.split(separator=" ", arg)
      if list.length(parts) < 3 then
        "invalid"
      elsif next_state() == "none" or next_state() == "started" or bumper_state() == "playing" then
        "none"
      else
        begin
          drop_bumper()
          playback_id = list.nth(parts, 0)
          resolve_limit = float_of_string(default=0., list.nth(parts, 1))
          uri = string.concat(separator=" ", list.tl(list.tl(parts)))
          generation = bumper_generation()
          bumper_state := "resolving"
          bumper_playback_id := playback_id
          thread.run(fun () ->
            begin
              r = request.create(uri)
              ok = request.resolve(timeout=resolve_limit, r)
              if bumper_generation() == generation and bumper_state() == "resolving" then
                if ok then
                  begin
                    bumper_pending := [r]
                    bumper_state := "ready"
                  end
                else
                  begin
                    request.destroy(r)
                    bumper_state := "none"
                    remember_bumper_result("dropped_unresolved")
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

# palazzo.recue_bumper <playback id> <time limit seconds> <annotated uri>: the spot already prepared, annotated
# again with the cue-out Palazzo measured after preparing it. It is resolved while the song plays and, once
# resolved, goes on air in place of the whole one; one that fails to resolve, or resolves after the spot was
# pushed or dropped, is discarded and changes nothing. It never holds or drops the spot: one still resolving
# whole when this one is ready is ready with this one. Answers "none" when that spot is not waiting (another
# spot, none, or already playing), "invalid" on a malformed command, else "ok".
server.register(
  namespace="palazzo",
  usage="recue_bumper <playback id> <time limit seconds> <uri>",
  description="Resolve the prepared spot again with its measured cue-out",
  "recue_bumper",
  fun (arg) ->
    begin
      parts = string.split(separator=" ", arg)
      if list.length(parts) < 3 then
        "invalid"
      elsif list.nth(parts, 0) != bumper_playback_id() or (bumper_state() != "resolving" and bumper_state() != "ready") then
        "none"
      else
        begin
          resolve_limit = float_of_string(default=0., list.nth(parts, 1))
          uri = string.concat(separator=" ", list.tl(list.tl(parts)))
          generation = bumper_generation()
          thread.run(fun () ->
            begin
              r = request.create(uri)
              ok = request.resolve(timeout=resolve_limit, r)
              if ok and bumper_generation() == generation and (bumper_state() == "resolving" or bumper_state() == "ready") then
                begin
                  list.iter(fun (old) -> request.destroy(old), bumper_recued())
                  bumper_recued := [r]
                  # A whole one still resolving is discarded when it resolves (its state check fails).
                  bumper_state := "ready"
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

# The per-item gain of an instant or an intro (gaulatti/palazzo#52): the request's liq_amplify annotation,
# which the API validates to a finite number in [0, 1]. Anything else (empty text excepted, which is an absent
# value) reads as 1, so it can neither silence an item nor make it louder than its file, and the item is
# logged once, with its request id and URL, so the file can be found. The song chain reads its own, computed
# liq_amplify and is not touched.
def item_gain(m) =
  raw = list.assoc(default="", "liq_amplify", m)
  g = float_of_string(default=-1., raw)
  if raw == "" then
    1.
  elsif g >= 0. and g <= 1. then
    g
  else
    id = list.assoc(default="", "palazzo_request_id", m)
    url = list.assoc(default="", "palazzo_url", m)
    log.important(label="item_gain", "ignored an invalid gain for #{id} (#{url}): it is not a number from 0 to 1; the item plays at its own level")
    1.
  end
end
intros_queue = request.queue(id="intros", prefetch=1)
# An intro never puts its file's own tags on the events either (gaulatti/palazzo#60): Palazzo annotates no
# title or artist for an intro, so the ones in its file (intro_started and intro_ended carry them) are
# blanked, as the instants chain does. The song's own title is set by its own track start.
intros_gained = metadata.map(
  id="intros_gain",
  strip=false,
  fun (m) -> [("liq_amplify", string(item_gain(m))), ("title", ""), ("artist", ""), ("song", "")],
  intros_queue
)
intros_per_item = amplify(override="liq_amplify", 1., intros_gained)
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

# Every instant is journalled on and off the air (gaulatti/palazzo#49, #50). The end of the announced
# spot opens the announced song's gate.
instants_requests.on_track(
  synchronous=true,
  fun (meta) ->
    begin
      # A spot dropped as not on air in time that comes on air anyway is skipped at once.
      if bumper_dropped_id() != "" and metadata_value("palazzo_request_id", meta) == bumper_dropped_id() then
        begin
          bumper_dropped_id := ""
          instants_requests.skip()
        end
      end
      remember_event("instant_started", meta)
      # An announced spot starts just before the song's end, while the song is still on air (palazzo#54).
      if metadata_value("palazzo_spot", meta) == "true" then
        put_station_title = station_title()
        put_station_title()
      end
      if bumper_state() == "playing" and metadata_value("palazzo_request_id", meta) == bumper_playback_id() then
        begin
          bumper_on_air := true
          remember_bumper_result("played")
        end
      end
    end
)
instants_requests.on_position(
  position={0.}, remaining=true, allow_partial=true, synchronous=true,
  fun (_, meta) ->
    begin
      remember_event("instant_ended", meta)
      if bumper_state() == "playing" and metadata_value("palazzo_request_id", meta) == bumper_playback_id() then
        begin
          bumper_state := "none"
          bumper_on_air := false
          open_gate_after_spot()
        end
      end
    end
)
# An instant never puts its file's own tags on the stream (gaulatti/palazzo#54): a spot file tagged with
# a song's title showed that title for the spot's whole length. With no song or intro on air (a spot by
# command, or an instant in a gap) its title is the station name; over a song it carries no title, so
# the song's stays. An announced spot starts just before the song's end, while the song is on air, so
# the mix drops its metadata: the station name is put on the stream for it directly (station_title).
# The next song's own track start sets its title as before.
instants_titled = metadata.map(
  id="instants_titles",
  insert_missing=true,
  strip=true,
  fun (m) ->
    if source.is_ready(songs) or source.is_ready(intros) then
      [("title", ""), ("artist", ""), ("song", ""), ("liq_amplify", string(item_gain(m)))]
    else
      [("title", "${liqString(options.streamName)}"), ("artist", ""), ("song", ""), ("liq_amplify", string(item_gain(m)))]
    end,
  instants_requests
)
instants_queue = mksafe(instants_titled)
instant_volume = interactive.float("palazzo_instant_volume", 1.)
instants_per_item = amplify(override="liq_amplify", 1., instants_queue)
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
# (song, intro, instant or live input) for FILLER_HOLDOFF_SECONDS
# (gaulatti/alcantara#230, gaulatti/palazzo#48).
# Production since 2026-11-19: the longest instant was 11 s and the longest
# time from an accepted song command to the song on air was 1 s; an ordinary
# handoff passes about 4 s with nothing on. 15 s clears all of them with margin
# and is still short of dead air. A song arriving takes the air at once.
# A live RTMP input on the air counts too, so the filler does not play under it.
${rtmpInput}
# Presence is read on the output's clock, once per frame, after radio (below), never from another thread.
filler_last_on_air = ref(time())
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
radio = add(normalize=false, [program_audio, instants${rtmpSource}])
radio = mksafe(radio)
station_title := fun () -> radio.insert_metadata([("title", "${liqString(options.streamName)}")])
# The filler's presence check runs on the clock that streams the station, before each frame. It used to run
# in a thread every 0.1 s, which asked these sources whether they were ready from a second thread while the
# clock was still waking them at startup. With a song deck's gate switch above its fades that raced: Liquidsoap
# 2.4.5 died at startup with CamlinternalLazy.Undefined ("Error while starting source switch"), 3 to 5 runs in
# 48 under load (production 2026-11-28 fix, CI run of verify-deck-marks.sh). On the clock it cannot race.
radio.on_frame(before=true, synchronous=true, fun () ->
  if source.is_ready(songs) or source.is_ready(intros) or source.is_ready(instants_requests)${livePresence} then
    filler_last_on_air := time()
  end
)
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
      live_on_air=${liveOnAir},
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
