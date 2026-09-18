/**
 * Lightweight, local motion-analysis pass over the raw screen source during
 * recording — the input Smart Camera (`smartCamera.ts`) uses to decide where
 * and when to move the camera in post.
 *
 * There's no way to read real click/scroll/cursor-position events out of an
 * arbitrary getDisplayMedia MediaStream — it's opaque pixels, possibly of a
 * different app entirely, and the browser gives no OS-level input hook for
 * it. So this derives "something happened here" from the only signal that's
 * actually available: how the captured pixels change over time. Runs on a
 * heavily downscaled offscreen canvas, sampled on an interval independent of
 * the compositor's own draw loop, so the per-sample cost is negligible.
 */

export const ACTIVITY_SAMPLE_INTERVAL_MS = 120;
const ANALYSIS_W = 160;
const ANALYSIS_H = 90;
export const GRID_COLS = 16;
export const GRID_ROWS = 9;
const ROW_PROFILE_COUNT = 24;

export interface ActivitySample {
  /** ms from recording start — matches RecordingSession.getElapsedMs() and
   * therefore ZoomKeyframe's own startMs/endMs timebase. */
  tMs: number;
  /** Per-cell motion energy vs. the previous sample (0..1ish), GRID_COLS *
   * GRID_ROWS, row-major. Empty (all zero) for the very first sample. */
  cells: Float32Array;
  /** This sample's own row-luminance profile (not a diff against the
   * previous one) — smartCamera.ts cross-correlates consecutive profiles to
   * detect a coherent vertical shift, the scroll signature. */
  rowProfile: Float32Array;
}

/**
 * Samples a screen `<video>` element on an interval and reduces each frame
 * to a coarse motion grid + row-luminance profile. Never touches the
 * compositor or recording pipeline — just observes the same source video
 * element they already read from.
 */
export class ActivityTracker {
  private samples: ActivitySample[] = [];
  private ctx: CanvasRenderingContext2D | null = null;
  private prevGray: Float32Array | null = null;
  private timer: number | null = null;
  private video: HTMLVideoElement | null = null;
  private getElapsedMs: (() => number) | null = null;

  start(video: HTMLVideoElement, getElapsedMs: () => number) {
    this.stop();
    this.video = video;
    this.getElapsedMs = getElapsedMs;
    this.samples = [];
    this.prevGray = null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = ANALYSIS_W;
      canvas.height = ANALYSIS_H;
      this.ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
    } catch {
      this.ctx = null;
    }
    // No canvas context (or no screen source) just means Smart Camera has no
    // data to work with later — never worth interrupting the recording for.
    if (!this.ctx) return;
    this.timer = window.setInterval(() => this.sample(), ACTIVITY_SAMPLE_INTERVAL_MS);
  }

  private sample() {
    const { ctx, video, getElapsedMs } = this;
    if (!ctx || !video || !getElapsedMs) return;
    if (video.readyState < 2 || video.videoWidth === 0) return;
    try {
      ctx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);
      const { data } = ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);
      const gray = new Float32Array(ANALYSIS_W * ANALYSIS_H);
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
        gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) / 255;
      }

      const cells = new Float32Array(GRID_COLS * GRID_ROWS);
      if (this.prevGray) {
        const prev = this.prevGray;
        const cellW = ANALYSIS_W / GRID_COLS;
        const cellH = ANALYSIS_H / GRID_ROWS;
        for (let gy = 0; gy < GRID_ROWS; gy++) {
          const y0 = Math.floor(gy * cellH);
          const y1 = Math.floor((gy + 1) * cellH);
          for (let gx = 0; gx < GRID_COLS; gx++) {
            const x0 = Math.floor(gx * cellW);
            const x1 = Math.floor((gx + 1) * cellW);
            let sum = 0;
            let n = 0;
            for (let y = y0; y < y1; y++) {
              const row = y * ANALYSIS_W;
              for (let x = x0; x < x1; x++) {
                sum += Math.abs(gray[row + x] - prev[row + x]);
                n++;
              }
            }
            cells[gy * GRID_COLS + gx] = n > 0 ? sum / n : 0;
          }
        }
      }

      const rowProfile = new Float32Array(ROW_PROFILE_COUNT);
      const bandH = ANALYSIS_H / ROW_PROFILE_COUNT;
      for (let r = 0; r < ROW_PROFILE_COUNT; r++) {
        const y0 = Math.floor(r * bandH);
        const y1 = Math.floor((r + 1) * bandH);
        let sum = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
          const row = y * ANALYSIS_W;
          for (let x = 0; x < ANALYSIS_W; x++) {
            sum += gray[row + x];
            n++;
          }
        }
        rowProfile[r] = n > 0 ? sum / n : 0;
      }

      this.samples.push({ tMs: getElapsedMs(), cells, rowProfile });
      this.prevGray = gray;
    } catch {
      // A transient getImageData failure (e.g. tab briefly backgrounded)
      // just costs one sample.
    }
  }

  /** Stops sampling and returns everything collected since start(). */
  stop(): ActivitySample[] {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const result = this.samples;
    this.samples = [];
    this.prevGray = null;
    this.ctx = null;
    this.video = null;
    this.getElapsedMs = null;
    return result;
  }
}
