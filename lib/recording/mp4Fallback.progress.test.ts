/**
 * Regression test for two "MP4 export progress looks broken" bugs.
 *
 * Bug 1, stuck at 0%: `MediaRecorder`-produced WebM has no Duration/Cues
 * element (it's written as an open-ended live stream), so ffmpeg.wasm can't
 * compute its own `progress` ratio against this input and reports it as ~0
 * for the entire transcode, even while actively encoding.
 * `computeTranscodeFraction` fixes this by deriving progress from `time`
 * (the actual encoded position) against a duration the caller already knows
 * is correct, instead of trusting ffmpeg's own `progress` field.
 *
 * Bug 2, stuck at 100%: measured live, `time` (and ffmpeg's own `progress`)
 * can reach the full known duration while a real double-digit-percent chunk
 * of wall-clock work still remains (~10 of ~20s in testing — the
 * `-movflags +faststart` mux has to finish writing/relocating the moov atom
 * after the last input frame is consumed). `computeTranscodeFraction` caps
 * every live in-flight value at `MAX_LIVE_FRACTION`; `transcodeToMp4` only
 * ever reports a true `1` once its promise actually resolves.
 *
 * No test runner is configured in this repo (see CLAUDE.md /
 * package.json — `pnpm lint` and `tsc --noEmit` are the only checks wired
 * up). This file has zero DOM/browser dependencies, so it can be run
 * directly against Node's native TypeScript stripping:
 *
 *   node --experimental-strip-types lib/recording/mp4Fallback.progress.test.ts
 *
 * If a test runner is ever added to this project, this file's assertions
 * can be dropped into it unchanged.
 */
import { computeTranscodeFraction, MAX_LIVE_FRACTION } from "./mp4Fallback.ts";

let failures = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL: ${label} — expected ${expected}, got ${actual}`);
  } else {
    console.log(`PASS: ${label}`);
  }
}

// The actual bug: ffmpeg.wasm reports progress ~0 (or NaN) for the whole
// transcode of a duration-less MediaRecorder WebM, while `time` (µs actually
// encoded) climbs normally. Without a known total duration, we have no
// choice but to fall back to ffmpeg's own (broken, here) progress field —
// this case documents that fallback rather than "fixing" the unfixable.
assertEqual(
  computeTranscodeFraction({ progress: 0, time: 5_000_000 }, undefined),
  0,
  "no known duration -> falls back to ffmpeg's own (here, stuck-at-0) progress field"
);

// The fix: with a known-good total duration (from the recorder's own
// wall-clock timer, immune to the container-metadata problem), progress is
// derived from `time` instead — so it correctly reports ~50% partway through
// a 10s recording even though ffmpeg's own `progress` field is still stuck
// reporting 0 for this same event.
assertEqual(
  computeTranscodeFraction({ progress: 0, time: 5_000_000 }, 10_000),
  0.5,
  "known duration -> derives progress from `time`, ignoring ffmpeg's stuck progress field"
);

// Bug 2: `time` reaching the full known duration must NOT report a live 1 —
// real completion (moov-atom relocation for `-movflags +faststart`, etc.)
// can still be many seconds away. Capped at MAX_LIVE_FRACTION instead.
assertEqual(
  computeTranscodeFraction({ progress: 0, time: 10_000_000 }, 10_000),
  MAX_LIVE_FRACTION,
  "known duration -> time reaching full duration caps at MAX_LIVE_FRACTION, not a live 1"
);

// ffmpeg.wasm can report progress/time briefly out of [0,1] or NaN before
// the first keyframe is measured, or overshoot past the known duration —
// must clamp to the same live cap, never propagate NaN or snap a progress
// bar backward past what it already showed.
assertEqual(
  computeTranscodeFraction({ progress: 0, time: 12_000_000 }, 10_000),
  MAX_LIVE_FRACTION,
  "known duration -> clamps time overshoot to MAX_LIVE_FRACTION"
);
assertEqual(
  computeTranscodeFraction({ progress: 1.4, time: NaN }, undefined),
  MAX_LIVE_FRACTION,
  "no known duration -> ffmpeg's own progress > 1 also caps at MAX_LIVE_FRACTION, never a live 1"
);
assertEqual(
  computeTranscodeFraction({ progress: NaN, time: NaN }, undefined),
  null,
  "no known duration, NaN progress -> null (caller must skip the update, not zero it)"
);
assertEqual(
  computeTranscodeFraction({ progress: 0.3, time: NaN }, 10_000),
  null,
  "known duration but NaN time -> null, not a false 0%"
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll assertions passed.");
}
