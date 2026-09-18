import type { CompositionEvent, ExportFormat, RecordingSettings } from "./types";

const MP4_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=h264,aac",
  "video/mp4",
];
const WEBM_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function pickMimeType(preferred: ExportFormat): { mimeType: string; format: ExportFormat } {
  const order = preferred === "mp4" ? [...MP4_CANDIDATES, ...WEBM_CANDIDATES] : [...WEBM_CANDIDATES, ...MP4_CANDIDATES];
  for (const type of order) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
      return { mimeType: type, format: type.includes("mp4") ? "mp4" : "webm" };
    }
  }
  return { mimeType: "", format: "webm" };
}

export type RecorderState = "idle" | "recording" | "paused" | "stopped";

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  format: ExportFormat;
  durationMs: number;
  compositionEvents: CompositionEvent[];
  /** ms-from-start timestamps for every explicit "mark a zoom here" trigger
   * during this take (the floating PiP control, or its in-tab fallback) —
   * distinct from anything Smart Camera infers on its own. */
  zoomMarkers: number[];
}

/**
 * Wraps MediaRecorder with pause/resume/restart and a composition-event log.
 * The event log is what lets a future editor replay layout/background
 * changes without asking the user to record again (see docs/ARCHITECTURE.md).
 */
export class RecordingSession {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;
  private pausedAccumMs = 0;
  private pausedAt = 0;
  private events: CompositionEvent[] = [];
  private zoomMarkers: number[] = [];
  public state: RecorderState = "idle";
  public mimeType = "";
  public format: ExportFormat = "webm";

  start(stream: MediaStream, videoBitsPerSecond: number, preferredFormat: ExportFormat) {
    const picked = pickMimeType(preferredFormat);
    this.mimeType = picked.mimeType;
    this.format = picked.format;
    this.chunks = [];
    this.events = [];
    this.zoomMarkers = [];
    this.pausedAccumMs = 0;
    this.recorder = new MediaRecorder(stream, {
      mimeType: picked.mimeType || undefined,
      videoBitsPerSecond,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250); // 250ms timeslice keeps memory bounded on long takes
    this.startedAt = performance.now();
    this.state = "recording";
  }

  pause() {
    if (this.state !== "recording" || !this.recorder) return;
    this.recorder.pause();
    this.pausedAt = performance.now();
    this.state = "paused";
  }

  resume() {
    if (this.state !== "paused" || !this.recorder) return;
    this.recorder.resume();
    this.pausedAccumMs += performance.now() - this.pausedAt;
    this.state = "recording";
  }

  /** Elapsed recording time, excluding paused spans — what the HUD shows. */
  getElapsedMs(): number {
    if (this.state === "idle") return 0;
    const now = this.state === "paused" ? this.pausedAt : performance.now();
    return now - this.startedAt - this.pausedAccumMs;
  }

  logCompositionEvent(type: CompositionEvent["type"], settings: Partial<RecordingSettings>) {
    if (this.state !== "recording" && this.state !== "paused") return;
    this.events.push({ atMs: this.getElapsedMs(), type, settings });
  }

  /** Records "the user intentionally pointed at this moment" — from the
   * floating PiP control or its in-tab fallback button, since neither can
   * know in advance where on screen to zoom (no cursor-position telemetry
   * is available; see smartCamera.ts). Resolved into an actual zoom rect
   * after the fact by searching nearby ActivityTracker samples. */
  markZoomPoint() {
    if (this.state !== "recording") return;
    this.zoomMarkers.push(this.getElapsedMs());
  }

  stop(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error("No active recording."));
        return;
      }
      const durationMs = this.getElapsedMs();
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType || "video/webm" });
        this.state = "stopped";
        resolve({
          blob,
          mimeType: this.mimeType,
          format: this.format,
          durationMs,
          compositionEvents: this.events,
          zoomMarkers: this.zoomMarkers,
        });
      };
      this.recorder.stop();
    });
  }

  /** Discards the current take entirely so the user can go again without
   * returning to the setup screen (PRD §16). */
  restart() {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
    this.events = [];
    this.zoomMarkers = [];
    this.pausedAccumMs = 0;
    this.state = "idle";
  }
}
