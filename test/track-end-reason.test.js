// gaulatti/palazzo#41: every track's end is reported with the reason it
// actually ended, bound to its own playback, never to one shared slot.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { StreamService } = require('../dist/stream/stream.service');
const { PlaybackTelemetryService } = require('../dist/stream/playback-telemetry.service');
const { mediaProbeResult } = require('./media-probe-fixture');

/**
 * A StreamService and its telemetry over a small simulation of the generated
 * Liquidsoap script: two song decks, the event journal, and the commands
 * Palazzo sends (song push, flush_and_skip, reset_decks, mark_ending).
 */
async function station(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'palazzo-end-reason-'));
  const values = {
    PLAYOUT_COMMAND_JOURNAL_PATH: join(root, 'commands.json'),
    PALAZZO_INSTANCE_ID: 'test-palazzo',
    PALAZZO_BUILD_VERSION: 'build-test',
  };
  const config = { get: (key) => values[key] };
  const telemetry = new PlaybackTelemetryService(config);
  const service = new StreamService(config, telemetry, { getRuntimeState: () => ({}) });
  service.logger = { log() {}, debug() {} };
  service.assetProbe = async () => mediaProbeResult();
  const liq = { decks: { a: null, b: null }, pushed: null, journal: [], sequence: 0, ingested: 0, failOn: null };
  const journal = (event_type, id, extra = {}) => {
    liq.sequence += 1;
    liq.journal.push({
      sequence: liq.sequence,
      event_type,
      playback_request_id: id,
      playback_id: id,
      parent_playback_id: '',
      program_id: '',
      title: id,
      artist: '',
      cover_url: '',
      url: `https://media.example.test/${id}.wav`,
      occurred_at: 1_700_000_000 + liq.sequence,
      ...extra,
    });
  };
  const end = (deck) => {
    const id = liq.decks[deck];
    if (!id) return;
    liq.decks[deck] = null;
    journal('track_ended', id);
  };
  service.telnet = {
    close() {},
    send: async (command) => {
      if (liq.failOn && command.startsWith(liq.failOn)) throw new Error('engine fixture');
      if (command.startsWith('palazzo.mark_ending ')) {
        const reason = command.slice('palazzo.mark_ending '.length);
        for (const deck of ['a', 'b']) if (liq.decks[deck]) journal('track_skipped', liq.decks[deck], { reason });
      } else if (command === 'palazzo.reset_decks') {
        end('b');
      } else if (command === 'songs.flush_and_skip') {
        end('a');
      } else if (command.startsWith('songs.push ')) {
        liq.pushed = /palazzo_request_id="([^"]+)"/.exec(command)[1];
      }
      return 'ok';
    },
  };
  t.after(async () => {
    service.onModuleDestroy();
    telemetry.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    service,
    telemetry,
    liq,
    /** Liquidsoap starts the pushed song (deck a) or an announced one (deck b). */
    start(deck = 'a', id = liq.pushed) {
      liq.decks[deck] = id;
      journal('track_started', id);
    },
    /** The song on a deck ends by itself. */
    naturalEnd(deck = 'a') {
      end(deck);
    },
    /** One telemetry poll: everything journalled since the last one. */
    ingest() {
      const events = liq.journal.slice(liq.ingested);
      liq.ingested = liq.journal.length;
      telemetry.apply(
        {
          liquidsoap_sequence: liq.sequence,
          playing: Boolean(liq.decks.a || liq.decks.b),
          playback_request_id: liq.decks.a || liq.decks.b || '',
          title: '', artist: '', cover_url: '', url: '',
          started_at: 0, elapsed: 0, remaining: 0,
          song_rms: 0, song_peak: 0, instant_rms: 0, instant_peak: 0,
          intro_playing: false, intro_playback_id: '', intro_parent_playback_id: '',
          intro_program_id: '', intro_request_id: '', intro_url: '', intro_started_at: 0,
          intro_rms: 0, intro_peak: 0, output_rms: 0, output_peak: 0,
          icecast_connected: true, sampled_at: 1_700_000_000,
        },
        events,
      );
    },
    push: (id) => service.playSong({ url: `https://media.example.test/${id}.wav`, playbackRequestId: id }),
    /** The end reason Palazzo reported for each playback, in order. */
    reasons() {
      return telemetry.replay
        .filter((event) => event.type === 'playout.skipped' || event.type === 'playout.stopped')
        .map((event) => [event.data.playbackRequestId, event.data.reason]);
    },
  };
}

test('an 8 s track pushed to an idle station and ending by itself reports natural_end', async (t) => {
  const s = await station(t);
  await s.push('one');
  s.start();
  s.ingest();
  s.naturalEnd();
  s.ingest();
  assert.deepEqual(s.reasons(), [['one', 'natural_end']]);
});

test('five pushes 100 ms apart: each earlier track reports replacement and the last natural_end', async (t) => {
  for (const batched of [false, true]) {
    const s = await station(t);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      await s.push(id);
      s.start();
      if (!batched) s.ingest();
    }
    s.naturalEnd();
    s.ingest();
    assert.deepEqual(
      s.reasons(),
      [['p1', 'replacement'], ['p2', 'replacement'], ['p3', 'replacement'], ['p4', 'replacement'], ['p5', 'natural_end']],
      batched ? 'all ends read in one poll' : 'each end read before the next push',
    );
  }
});

test('a stop with nothing on air does not label the next track, and a stop on air reads operator', async (t) => {
  const s = await station(t);
  await s.service.stopSong();
  await s.push('after-stop');
  s.start();
  s.ingest();
  await s.service.stopSong();
  s.ingest();
  await s.push('next');
  s.start();
  s.naturalEnd();
  s.ingest();
  assert.deepEqual(s.reasons(), [['after-stop', 'operator'], ['next', 'natural_end']]);
});

test('a natural end just before a command keeps natural_end, and the track the command cut reads replacement', async (t) => {
  const s = await station(t);
  await s.push('first');
  s.start();
  s.ingest();
  s.service.decksUsed = true; // the next song was announced
  // "first" ends by itself; the announced song starts on deck b; a push then cuts it, all in one poll.
  s.naturalEnd('a');
  s.start('b', 'announced');
  await s.push('third');
  s.ingest();
  assert.deepEqual(s.reasons(), [['first', 'natural_end'], ['announced', 'replacement']]);
});

test("a failed command does not erase another command's reason, nor label the track it failed to cut", async (t) => {
  const s = await station(t);
  await s.push('a1');
  s.start();
  s.ingest();
  await s.push('a2'); // cuts a1; its end is not read yet
  s.start();
  s.liq.failOn = 'songs.flush_and_skip';
  await assert.rejects(s.push('a3'), /engine fixture/);
  s.liq.failOn = null;
  s.ingest();
  s.naturalEnd();
  s.ingest();
  assert.deepEqual(s.reasons(), [['a1', 'replacement'], ['a2', 'natural_end']]);
});

test('an overlap cut by a song command reads replacement for both decks', async (t) => {
  const s = await station(t);
  s.service.decksUsed = true; // an announcement was made, so song commands reset the decks first
  await s.push('outgoing');
  s.start('a');
  s.start('b', 'incoming'); // the announced song started under the end of the current one
  s.ingest();
  await s.push('cut');
  s.ingest();
  assert.deepEqual(s.reasons(), [['incoming', 'replacement'], ['outgoing', 'replacement']]);
});

test('playout.skipped and playout.stopped keep their event shape', async (t) => {
  const s = await station(t);
  await s.push('x');
  s.start();
  s.ingest();
  await s.push('y');
  s.start();
  s.naturalEnd();
  s.ingest();
  const keys = (type) => Object.keys(s.telemetry.replay.find((event) => event.type === type).data).sort();
  for (const type of ['playout.skipped', 'playout.stopped']) {
    assert.deepEqual(keys(type), ['liquidsoapSequence', 'playbackId', 'playbackRequestId', 'programId', 'reason']);
  }
});

test('end reasons are bounded to 64 playbacks, oldest first, and cancel or unknown reasons are no-ops', () => {
  const telemetry = new PlaybackTelemetryService({ get: () => undefined });
  const event = (sequence, id, reason) => ({
    sequence, event_type: 'track_skipped', playback_request_id: id, playback_id: id, parent_playback_id: '',
    program_id: '', title: '', artist: '', cover_url: '', url: '', reason, occurred_at: 1_700_000_000,
  });
  const snapshot = (sequence) => ({ liquidsoap_sequence: sequence, playing: false, sampled_at: 1_700_000_000 });
  const events = Array.from({ length: 70 }, (_, i) => event(i + 1, `id-${i}`, i % 2 ? 'operator' : 'replacement'));
  telemetry.apply(snapshot(70), events);
  assert.equal(telemetry.endReasons.size, 64);
  assert.equal(telemetry.endReasons.has('id-5'), false);
  assert.equal(telemetry.endReasons.get('id-6'), 'replacement');
  telemetry.apply(snapshot(72), [event(71, 'id-6', 'cancel'), event(72, 'id-7', 'bogus')]);
  assert.equal(telemetry.endReasons.has('id-6'), false);
  assert.equal(telemetry.endReasons.get('id-7'), 'operator');
  telemetry.shutdown();
});
