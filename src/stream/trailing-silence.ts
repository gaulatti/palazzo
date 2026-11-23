// gaulatti/palazzo#55: a spot or an instant file can end in digital silence that its operator never meant
// to air (measured on production: 0.57, 0.32, 0.25 and 0.16 s on four of five spots), which opens a gap
// before the announced song. Palazzo measures it when it prepares the item and cues the item out at its last
// audio; the file is never changed and the file's own cue tags stay ignored (gaulatti/palazzo#60).

/** The silencedetect noise floor, in dB, and the shortest silence it reports, in seconds. */
export const SILENCE_NOISE_DB = -85;
export const SILENCE_MIN_SECONDS = 0.05;
/** The most a cue-out may trim, so a long silence in the middle of an item's tail never cuts content. */
export const MAX_TRIM_SECONDS = 1;

export interface TrailingSilence {
  durationSeconds: number;
  trailingSilenceSeconds: number;
}

/** ffmpeg's `Duration: HH:MM:SS.cc` line (else its last progress `time=`) as seconds, or null when neither exists. */
function durationOf(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  // A file read over HTTP can carry no duration header; the last progress `time=` is then how far it decoded.
  const times = [...stderr.matchAll(/time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const last = times[times.length - 1];
  return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null;
}

/**
 * The trailing digital silence of a file, from the stderr of
 * `ffmpeg -i <file> -af silencedetect=noise=-85dB:d=0.05 -f null -`.
 * A silence is trailing when it runs to the end of the file (its end is within 0.1 s of the duration, or it
 * never ends). A silence in the middle is not trailing; an unparseable output is an error, not a zero.
 */
export function parseTrailingSilence(stderr: string): TrailingSilence {
  const durationSeconds = durationOf(stderr);
  if (durationSeconds === null || durationSeconds <= 0) {
    throw new Error("the file's duration is not known");
  }
  const intervals: Array<{ start: number; end: number | null }> = [];
  for (const line of stderr.split("\n")) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) {
      intervals.push({ start: Math.max(0, Number(start[1])), end: null });
      continue;
    }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (end && intervals.length) intervals[intervals.length - 1].end = Number(end[1]);
  }
  const last = intervals[intervals.length - 1];
  if (!last || (last.end !== null && last.end < durationSeconds - 0.1)) {
    return { durationSeconds, trailingSilenceSeconds: 0 };
  }
  return {
    durationSeconds,
    trailingSilenceSeconds: Math.max(0, durationSeconds - last.start),
  };
}

/**
 * Where to cue an item out, in seconds from its start, or null to play it whole: its end minus the trailing
 * silence, the trim capped at MAX_TRIM_SECONDS. Nothing is trimmed below the detector's own minimum.
 */
export function cueOutSeconds(measured: TrailingSilence): number | null {
  if (measured.trailingSilenceSeconds < SILENCE_MIN_SECONDS) return null;
  const trim = Math.min(measured.trailingSilenceSeconds, MAX_TRIM_SECONDS);
  const cue = measured.durationSeconds - trim;
  return cue > 0 ? Math.round(cue * 1000) / 1000 : null;
}
