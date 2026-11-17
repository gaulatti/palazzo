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
# Per-song loudness gain from the liq_amplify annotation; 1.0 when absent.
songs_normalized = amplify(override="liq_amplify", 1., songs_queue)
song_volume = interactive.float("palazzo_song_volume", 1.)
songs_controlled = amplify(override=null, song_volume, songs_normalized)
# Per-song fades from liq_fade_in / liq_fade_out; no fade when absent.
songs_faded = fade.in(duration=0., track_sensitive=true, songs_controlled)
songs_faded = fade.out(duration=0., track_sensitive=true, songs_faded)
songs_rms = rms(id="songs_rms", duration=0.1, songs_faded)
get_song_rms = songs_rms.rms
songs = peak(id="songs_peak", duration=0.1, songs_rms)
get_song_peak = songs.peak

songs.on_track(
  synchronous=false,
  fun (meta) ->
    begin
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

songs.on_position(
  position=0., remaining=true, allow_partial=true, synchronous=false,
  fun (_, meta) ->
    begin
      remember_event("track_ended", meta)
      if metadata_value("palazzo_request_id", meta) == current_request_id() then
        current_playing := false
      end
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

instants_queue = mksafe(request.queue(id="instants"))
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
filler = mksafe(filler_playlist)
intro_duck_gain = interactive.float("palazzo_intro_duck_gain", 0.35)
ducked_songs = smooth_add(
  duration=0.25,
  p=intro_duck_gain,
  normal=songs,
  special=intros
)
program_audio = fallback(track_sensitive=false, [ducked_songs, filler])
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
      elapsed=finite_level(songs.elapsed()),
      remaining=finite_level(songs.remaining()),
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
