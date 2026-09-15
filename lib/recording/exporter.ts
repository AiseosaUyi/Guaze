import type { AspectRatioId, ExportFormat, ZoomKeyframe } from "./types";
import { pickMimeType } from "./recorder";
import { ASPECT_RATIOS } from "./presets";

export interface ExportOptions {
  sourceBlob: Blob;
  width: number;
  height: number;
  fps: number;
  videoBitsPerSecond: number;
  format: ExportFormat;
  aspect: AspectRatioId;
  zoomKeyframes?: ZoomKeyframe[];
  onProgress?: (fraction: number) => void;
}

const FULL_RECT = { x: 0, y: 0, w: 1, h: 1 };
/** Ease-in/out window either side of a keyframe's [start, end] — the zoom
 * glides in, holds, then glides back out rather than snapping. */
const ZOOM_TRANSITION_MS = 350;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerpRect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  t: number
) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

/** Normalized (0..1, relative to the full source frame) region the export
 * should be zoomed into at `timeMs`, easing between the full frame and each
 * keyframe's target rect at its boundaries. Keyframes are assumed
 * non-overlapping, so the first match wins. */
function getActiveZoomRect(keyframes: ZoomKeyframe[], timeMs: number) {
  for (const kf of keyframes) {
    if (timeMs < kf.startMs - ZOOM_TRANSITION_MS || timeMs > kf.endMs + ZOOM_TRANSITION_MS) continue;
    let t: number;
    if (timeMs < kf.startMs) {
      t = (timeMs - (kf.startMs - ZOOM_TRANSITION_MS)) / ZOOM_TRANSITION_MS;
    } else if (timeMs > kf.endMs) {
      t = 1 - (timeMs - kf.endMs) / ZOOM_TRANSITION_MS;
    } else {
      t = 1;
    }
    return lerpRect(FULL_RECT, kf.rect, easeInOutCubic(Math.max(0, Math.min(1, t))));
  }
  return FULL_RECT;
}

export interface ExportResult {
  blob: Blob;
  format: ExportFormat;
  fileExtension: string;
}

/**
 * Re-renders the recorded take at the chosen resolution/fps/bitrate/aspect
 * by playing it back into a canvas (cropped/fit per the target aspect) and
 * re-recording that canvas — the same compose-then-record pattern the live
 * studio uses. This is what lets one recording produce a 16:9 YouTube export
 * and a 9:16 TikTok export without re-recording (PRD §6), entirely with
 * browser APIs and no server round trip.
 *
 * A WebCodecs-based transcode would be faster and avoid the realtime-playback
 * constraint; that's a good Phase 1 upgrade once broader codec support can be
 * assumed. This is the simple, reliable version for the foundation.
 */
export async function exportRecording(opts: ExportOptions): Promise<ExportResult> {
  const sourceUrl = URL.createObjectURL(opts.sourceBlob);
  const video = document.createElement("video");
  video.src = sourceUrl;
  video.muted = false;
  video.playsInline = true;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Could not read the recording."));
  });

  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2D canvas context is not available.");

  const targetRatio = ASPECT_RATIOS[opts.aspect].ratio ?? video.videoWidth / video.videoHeight;
  const zoomKeyframes = opts.zoomKeyframes ?? [];

  const draw = () => {
    // First crop down to whatever region the active zoom keyframe (if any)
    // wants on screen right now, then fit-crop THAT region to the target
    // aspect ratio — same "cover" math as before, just operating on the
    // zoomed-in bounds instead of the full frame.
    const zoom = getActiveZoomRect(zoomKeyframes, video.currentTime * 1000);
    const zx = zoom.x * video.videoWidth;
    const zy = zoom.y * video.videoHeight;
    const zw = zoom.w * video.videoWidth;
    const zh = zoom.h * video.videoHeight;

    const srcRatio = zw / zh;
    let sw = zw;
    let sh = zh;
    if (srcRatio > targetRatio) {
      sw = zh * targetRatio;
    } else {
      sh = zw / targetRatio;
    }
    const sx = zx + (zw - sw) / 2;
    const sy = zy + (zh - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  };

  const canvasStream = canvas.captureStream(opts.fps);
  const mediaStream = new MediaStream();
  canvasStream.getVideoTracks().forEach((t) => mediaStream.addTrack(t));
  // captureStream() on the source <video> carries its decoded audio track
  // through untouched — we only need to resample the picture, not the sound.
  const audioCapable = video as HTMLVideoElement & { captureStream?: () => MediaStream };
  audioCapable.captureStream?.().getAudioTracks().forEach((t) => mediaStream.addTrack(t));

  const { mimeType, format } = pickMimeType(opts.format);
  const recorder = new MediaRecorder(mediaStream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: opts.videoBitsPerSecond,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const durationMs = video.duration * 1000;
  let rafId = 0;
  const tick = () => {
    draw();
    opts.onProgress?.(Math.min(1, video.currentTime / (video.duration || 1)));
    if (!video.ended) rafId = requestAnimationFrame(tick);
  };

  const result = await new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
    recorder.onerror = () => reject(new Error("Export failed while encoding."));
    video.onended = () => {
      cancelAnimationFrame(rafId);
      recorder.stop();
    };
    video
      .play()
      .then(() => {
        recorder.start(250);
        rafId = requestAnimationFrame(tick);
      })
      .catch(reject);
    // Safety timeout in case `ended` never fires (e.g. a zero-length take).
    window.setTimeout(
      () => {
        if (recorder.state === "recording") {
          cancelAnimationFrame(rafId);
          recorder.stop();
        }
      },
      Math.max(2000, durationMs + 3000)
    );
  });

  URL.revokeObjectURL(sourceUrl);
  return { blob: result, format, fileExtension: format === "mp4" ? "mp4" : "webm" };
}
