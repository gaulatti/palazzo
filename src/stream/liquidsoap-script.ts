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
}

function liqString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

export function buildLiquidsoapScript(
  options: LiquidsoapScriptOptions,
): string {
  const rtmpInput = options.rtmpUrl
    ? `live = mksafe(input.rtmp("${liqString(options.rtmpUrl)}"))`
    : '';
  const rtmpSource = options.rtmpUrl ? ', live' : '';

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
      title=metadata_value("title", meta),
      artist=metadata_value("artist", meta),
      cover_url=metadata_value("cover_url", meta),
      url=metadata_value("palazzo_url", meta),
      occurred_at=time()
    })
    events := [body, ...list.prefix(127, events())]
  end
end

songs_queue = request.queue(id="songs")
songs_rms = rms(id="songs_rms", duration=0.1, songs_queue)
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

instants_queue = mksafe(request.queue(id="instants"))
instants_rms = rms(id="instants_rms", duration=0.1, instants_queue)
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
program_audio = fallback(track_sensitive=false, [songs, filler])
${rtmpInput}
radio = add(normalize=false, [program_audio, instants${rtmpSource}])
radio = mksafe(radio)
radio_rms = rms(id="radio_rms", duration=0.1, radio)
get_rms = radio_rms.rms
radio = peak(id="radio_peak", duration=0.1, radio_rms)
get_peak = radio.peak

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
      elapsed=songs.elapsed(),
      remaining=songs.remaining(),
      song_rms=get_song_rms(),
      song_peak=get_song_peak(),
      instant_rms=get_instant_rms(),
      instant_peak=get_instant_peak(),
      output_rms=get_rms(),
      output_peak=get_peak(),
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
