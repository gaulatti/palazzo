# Voice-to-ear latency harness (gaulatti/palazzo#47)

A proof harness, not part of the product. It runs only against a local or proof image, never against the live input, because clicks pushed there would go on air.

1. `push-clicks.mjs` paces 48 kHz mono PCM, silence with one 2 ms full-scale click every `--spacing` ms, into the encoder command given after `--`. It logs the wall-clock time each click's first sample is handed over (`sent.jsonl`).
2. `listener.html` plays the path under test in a browser: `?src=<Icecast mount>`, or `?livekit=<ws url>&token=<subscribe token>`. It detects each click's onset and logs when it reaches the speaker, including the AudioContext output latency (`window.earLog`; Copy exports JSON lines to `ear.jsonl`).
3. `analyze.mjs sent.jsonl ear.jsonl` pairs the clicks in order and prints per-click latency, median, min and max. It refuses when a latency exceeds the spacing, because pairing would then be ambiguous.

Both ends run on the same machine, so one clock serves both. Use at least 12 clicks with `--spacing 10000` on the Icecast path (more than 4 s); `--spacing 2000` is enough for WebRTC.

Self-test without any image: `node push-clicks.mjs --clicks 3 --spacing 1000 --lead 500 -- ffmpeg -f s16le -ar 48000 -ac 1 -i - out.wav` writes onsets at 0.5, 1.5 and 2.5 s.
