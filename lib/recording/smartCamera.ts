import type { ZoomKeyframe } from "./types";
import { GRID_COLS, GRID_ROWS, type ActivitySample } from "./activity";

/**
 * Turns the raw motion samples captured during recording (`activity.ts`)
 * into the same `ZoomKeyframe[]` the manual zoom editor already produces —
 * Smart Camera is just another *producer* of that data, not a parallel
 * system. Everything downstream (drag-to-edit in `ZoomEditor.tsx`, the
 * export re-render in `exporter.ts`, aspect-ratio reframing) is unchanged.
 *
 * Classification, in order of what the resulting camera move should do:
 *  - "local"  — motion confined to a small region (a click, a hover, typing
 *    in one field) → the thing worth punching in on.
 *  - "scroll" — a coherent vertical shift across most of the frame, the
 *    trackpad/mouse-wheel signature → deliberately produces NO keyframe.
 *    This is what keeps scrolling from ever reading as jerky: rather than
 *    chasing every momentum tick with a camera move, the camera simply holds
 *    still through the whole scroll (and any trailing momentum) and only
 *    reacts once the page/content actually settles into a "local" burst
 *    again. Device-agnostic by construction — it reacts to the resulting
 *    pixel motion, never to which input device produced it.
 *  - "broad"  — large, incoherent motion (a page navigation, a video
 *    playing, a window switch) → also produces no keyframe; punching in
 *    during a scene change would fight the cut instead of directing it.
 *  - "idle"   — nothing happening → ends whatever burst was in progress.
 */

export const DEFAULT_SMART_CAMERA_INTENSITY = 0.45;
const MIN_ZOOM = 1.12;
const MAX_ZOOM = 1.5;

/** Exported so the editor UI can compute the same "reset to default" rect
 * size a fresh auto-keyframe would use at the current intensity. */
export function zoomFactorForIntensity(intensity: number): number {
  const t = Math.max(0, Math.min(1, intensity));
  return MIN_ZOOM + t * (MAX_ZOOM - MIN_ZOOM);
}

const CELL_ACTIVE_THRESHOLD = 0.028;
/** At or below this fraction of the grid moving, motion reads as confined
 * to one spot (a click, a hover, typing) rather than spread across the
 * frame — everything above it (including the ambiguous band up to the
 * scroll/broad check) is treated as "not a local moment". */
const LOCAL_MAX_ACTIVE_FRACTION = 0.28;
const SCROLL_MIN_ACTIVE_FRACTION = 0.5;
const SCROLL_CORRELATION_MIN = 0.6;
const SCROLL_SEARCH_ROWS = 4;

const SETTLE_GAP_MS = 550;
const MIN_BURST_MS = 150;
const PRE_ROLL_MS = 120;
const MIN_HOLD_MS = 900;
const MAX_HOLD_MS = 4500;
const MERGE_GAP_MS = 450;
const MERGE_DIST = 0.22;
const MIN_GAP_BETWEEN_KEYFRAMES_MS = 700;

/** The open span of time at `ms` not already covered by any keyframe —
 * shared by the manual "Add zoom at playhead" editor and by resolving an
 * intentional marker (below) into a keyframe, so both respect the same
 * "keyframes never overlap" rule the export pipeline assumes. */
export function findZoomGapAt(
  keyframes: ZoomKeyframe[],
  durationMs: number,
  ms: number
): { start: number; end: number } | null {
  const sorted = [...keyframes].sort((a, b) => a.startMs - b.startMs);
  let start = 0;
  for (const kf of sorted) {
    if (ms < kf.startMs) return ms >= start ? { start, end: kf.startMs } : null;
    start = kf.endMs;
  }
  return ms >= start ? { start, end: durationMs } : null;
}

const MARKER_SEARCH_WINDOW_MS = 800;
const MARKER_PRE_ROLL_MS = 150;
const MARKER_HOLD_MS = 2000;
const MARKER_MIN_SPAN_MS = 400;

/** Finds the nearest-in-time detected "local" (click/typing-like) motion
 * burst within `windowMs` of `atMs` and returns its centroid — an
 * intentional marker only knows *when* the user reacted to something, not
 * *where* on screen, so this borrows the same motion classification Smart
 * Camera itself uses to fill in the "where". Returns null (falls back to a
 * centered default) if nothing nearby was detected. */
export function findNearbyActivityCentroid(
  samples: ActivitySample[],
  atMs: number,
  windowMs: number = MARKER_SEARCH_WINDOW_MS
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const dist = Math.abs(sample.tMs - atMs);
    if (dist > windowMs || dist >= bestDist) continue;
    const prev = i > 0 ? samples[i - 1] : null;
    const { kind, centroid } = classify(sample, prev);
    if (kind !== "local" || !centroid) continue;
    best = centroid;
    bestDist = dist;
  }
  return best;
}

/** Turns one intentional "mark a zoom here" trigger into a ZoomKeyframe,
 * centered on nearby detected activity if any was found (or the frame
 * center otherwise), clipped to whatever open gap contains `markerMs` in
 * `existingKeyframes`. Returns null if the marker landed inside (or too
 * close to) a span another keyframe already covers — that keyframe already
 * has this moment handled, so there's nothing to add. */
export function createMarkerKeyframe(
  markerMs: number,
  activitySamples: ActivitySample[] | undefined,
  existingKeyframes: ZoomKeyframe[],
  durationMs: number,
  intensity: number
): ZoomKeyframe | null {
  const gap = findZoomGapAt(existingKeyframes, durationMs, markerMs);
  if (!gap || gap.end - gap.start < MARKER_MIN_SPAN_MS) return null;

  const centroid = (activitySamples && findNearbyActivityCentroid(activitySamples, markerMs)) ?? {
    x: 0.5,
    y: 0.5,
  };
  const size = 1 / zoomFactorForIntensity(intensity);
  const x = Math.max(0, Math.min(1 - size, centroid.x - size / 2));
  const y = Math.max(0, Math.min(1 - size, centroid.y - size / 2));

  const startMs = Math.max(gap.start, markerMs - MARKER_PRE_ROLL_MS);
  const endMs = Math.min(gap.end, startMs + MARKER_HOLD_MS);
  if (endMs - startMs < MARKER_MIN_SPAN_MS) return null;

  return {
    id: `marker-${Math.round(markerMs)}-${Math.round(x * 1000)}`,
    startMs,
    endMs,
    rect: { x, y, w: size, h: size },
    source: "manual",
  };
}

/** Folds every intentional marker into `baseKeyframes` (typically Smart
 * Camera's own auto-detected set), one at a time so each marker sees the
 * gaps left by the ones already inserted — this is what keeps two markers
 * a moment apart from producing overlapping keyframes. A marker that lands
 * inside a span an existing keyframe already covers is silently dropped:
 * that moment already has a zoom, so there's nothing to add. */
export function resolveZoomMarkers(
  markers: number[],
  activitySamples: ActivitySample[] | undefined,
  baseKeyframes: ZoomKeyframe[],
  durationMs: number,
  intensity: number
): ZoomKeyframe[] {
  let result = baseKeyframes;
  for (const markerMs of markers) {
    const kf = createMarkerKeyframe(markerMs, activitySamples, result, durationMs, intensity);
    if (kf) result = [...result, kf].sort((a, b) => a.startMs - b.startMs);
  }
  return result;
}

type Classification = "idle" | "local" | "scroll" | "broad";

function normalizeVector(v: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < v.length; i++) mean += v[i];
  mean /= v.length || 1;
  const out = new Float32Array(v.length);
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i] - mean;
    sumSq += out[i] * out[i];
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < v.length; i++) out[i] /= norm;
  return out;
}

/** Cross-correlates two row-luminance profiles across a small vertical
 * search window and returns the best-matching shift + its correlation
 * strength — a cheap stand-in for optical flow that's enough to tell "the
 * whole frame just slid vertically" (scrolling) apart from "a bunch of
 * pixels changed with no coherent direction" (typing, a video playing). */
function bestRowShiftCorrelation(a: Float32Array, b: Float32Array): { shift: number; correlation: number } {
  const na = normalizeVector(a);
  const nb = normalizeVector(b);
  let best = { shift: 0, correlation: -1 };
  for (let shift = -SCROLL_SEARCH_ROWS; shift <= SCROLL_SEARCH_ROWS; shift++) {
    let dot = 0;
    let count = 0;
    for (let i = 0; i < na.length; i++) {
      const j = i + shift;
      if (j < 0 || j >= nb.length) continue;
      dot += na[i] * nb[j];
      count++;
    }
    if (count < na.length * 0.6) continue;
    if (dot > best.correlation) best = { shift, correlation: dot };
  }
  return best;
}

function classify(
  sample: ActivitySample,
  prev: ActivitySample | null
): { kind: Classification; centroid: { x: number; y: number } | null } {
  let activeCount = 0;
  let sumX = 0;
  let sumY = 0;
  let sumW = 0;
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      const v = sample.cells[gy * GRID_COLS + gx];
      if (v > CELL_ACTIVE_THRESHOLD) {
        activeCount++;
        sumX += ((gx + 0.5) / GRID_COLS) * v;
        sumY += ((gy + 0.5) / GRID_ROWS) * v;
        sumW += v;
      }
    }
  }
  const activeFraction = activeCount / (GRID_COLS * GRID_ROWS);
  const centroid = sumW > 0 ? { x: sumX / sumW, y: sumY / sumW } : null;

  if (activeFraction < 0.01 || !centroid) return { kind: "idle", centroid: null };

  if (prev && activeFraction >= SCROLL_MIN_ACTIVE_FRACTION) {
    const { correlation, shift } = bestRowShiftCorrelation(sample.rowProfile, prev.rowProfile);
    if (correlation >= SCROLL_CORRELATION_MIN && shift !== 0) {
      return { kind: "scroll", centroid };
    }
  }

  if (activeFraction <= LOCAL_MAX_ACTIVE_FRACTION) return { kind: "local", centroid };
  return { kind: "broad", centroid };
}

interface Burst {
  startMs: number;
  lastActiveMs: number;
  cx: number;
  cy: number;
  weight: number;
}

interface RawBurst {
  startMs: number;
  endMs: number;
  cx: number;
  cy: number;
}

/**
 * Computes auto-generated zoom keyframes from a recording's motion samples.
 * Pure and DOM-free — safe to call from the store on every intensity change
 * without re-touching the recording itself (non-destructive, same as manual
 * keyframes: this only ever produces editable data consumed at export time).
 */
export function generateSmartZoomKeyframes(
  samples: ActivitySample[],
  durationMs: number,
  intensity: number = DEFAULT_SMART_CAMERA_INTENSITY
): ZoomKeyframe[] {
  if (samples.length < 3 || durationMs <= 0) return [];

  const zoomFactor = zoomFactorForIntensity(intensity);
  const rectSize = 1 / zoomFactor;

  const rawBursts: RawBurst[] = [];
  let current: Burst | null = null;

  const closeBurst = () => {
    if (!current) return;
    if (current.lastActiveMs - current.startMs >= MIN_BURST_MS) {
      rawBursts.push({
        startMs: current.startMs,
        endMs: current.lastActiveMs,
        cx: current.cx / current.weight,
        cy: current.cy / current.weight,
      });
    }
    current = null;
  };

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;
    const { kind, centroid } = classify(sample, prev);

    if (kind === "local" && centroid) {
      if (current && sample.tMs - current.lastActiveMs > SETTLE_GAP_MS) closeBurst();
      if (!current) current = { startMs: sample.tMs, lastActiveMs: sample.tMs, cx: 0, cy: 0, weight: 0 };
      current.lastActiveMs = sample.tMs;
      current.cx += centroid.x;
      current.cy += centroid.y;
      current.weight += 1;
    } else if (kind === "idle") {
      if (current && sample.tMs - current.lastActiveMs > SETTLE_GAP_MS) closeBurst();
    } else {
      // scroll / broad — attention is clearly moving on; never let a hold
      // span across it.
      closeBurst();
    }
  }
  closeBurst();

  if (rawBursts.length === 0) return [];

  // Merge bursts close in both time and space into one continuous hold,
  // instead of a rapid zoom-out/zoom-in flicker between two clicks a few
  // hundred ms apart in roughly the same spot.
  const merged: RawBurst[] = [];
  for (const b of rawBursts) {
    const last = merged[merged.length - 1];
    if (last && b.startMs - last.endMs <= MERGE_GAP_MS && Math.hypot(b.cx - last.cx, b.cy - last.cy) <= MERGE_DIST) {
      last.endMs = b.endMs;
      // Weighted toward the most recent burst's location — attention has
      // likely settled there, not at the merged pair's midpoint.
      last.cx = b.cx;
      last.cy = b.cy;
    } else {
      merged.push({ ...b });
    }
  }

  const keyframes: ZoomKeyframe[] = [];
  let counter = 0;
  for (const b of merged) {
    const startMs = Math.max(0, b.startMs - PRE_ROLL_MS);
    const holdEnd = Math.max(b.endMs, b.startMs + MIN_HOLD_MS);
    const endMs = Math.min(durationMs, Math.min(holdEnd, b.startMs + MAX_HOLD_MS));
    if (endMs - startMs < MIN_BURST_MS) continue;

    const prevKf = keyframes[keyframes.length - 1];
    if (prevKf && startMs - prevKf.endMs < MIN_GAP_BETWEEN_KEYFRAMES_MS) {
      // Too close to the previous shot to zoom out and back in without it
      // reading as a flicker — extend the previous hold instead.
      prevKf.endMs = Math.max(prevKf.endMs, endMs);
      continue;
    }

    const x = Math.max(0, Math.min(1 - rectSize, b.cx - rectSize / 2));
    const y = Math.max(0, Math.min(1 - rectSize, b.cy - rectSize / 2));
    keyframes.push({
      id: `auto-${counter++}-${Math.round(startMs)}`,
      startMs,
      endMs,
      rect: { x, y, w: rectSize, h: rectSize },
      source: "auto",
    });
  }

  return keyframes;
}
