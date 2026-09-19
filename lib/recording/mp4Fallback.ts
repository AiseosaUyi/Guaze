/**
 * Last-resort client-side MP4 transcode for browsers where MediaRecorder's
 * own H.264 encoder can't actually initialize for a canvas+audio stream —
 * `MediaRecorder.isTypeSupported()` claims MP4 is supported, then `.start()`
 * throws `EncodingError` (a real, observed Chrome/OS-level limitation, not
 * something this app can avoid by picking a different codec string).
 *
 * `exporter.ts` already falls back to WebM when that happens. This module
 * is the next step for a user who specifically asked for MP4: it re-encodes
 * that WebM into a genuine MP4 using ffmpeg.wasm, entirely client-side —
 * still no server, still nothing leaves the device, same as the rest of the
 * app. It's deliberately isolated from the native export path so the common
 * case (native MP4 or WebM both work fine) never pays for it.
 *
 * ffmpeg-core.js/.wasm and the worker's own module are self-hosted under
 * public/ffmpeg/ (see scripts/copy-ffmpeg-core.mjs) rather than fetched from
 * a CDN — this app's "static export, works offline once loaded, can be
 * served from anywhere" property shouldn't depend on a third-party host
 * being up.
 */
import type { FFmpeg } from "@ffmpeg/ffmpeg";

let ffmpegPromise: Promise<FFmpeg> | null = null;
let ffmpegLoaded = false;

async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const ffmpeg = new FFmpeg();
      // Fully-qualified URLs, not root-relative paths: the FFmpeg class
      // resolves classWorkerURL against its own module's import.meta.url
      // (`new URL(classWorkerURL, import.meta.url)`), which under Turbopack
      // ends up being the package's file:// path in node_modules rather
      // than this page's origin — a root-relative "/ffmpeg/worker.js" then
      // resolves to "file:///ffmpeg/worker.js" and the Worker constructor
      // rejects it. An absolute URL sidesteps that resolution entirely.
      const base = window.location.origin;
      await ffmpeg.load({
        coreURL: `${base}/ffmpeg/ffmpeg-core.js`,
        wasmURL: `${base}/ffmpeg/ffmpeg-core.wasm`,
        classWorkerURL: `${base}/ffmpeg/worker.js`,
      });
      ffmpegLoaded = true;
      return ffmpeg;
    })().catch((err) => {
      // Let the next call try again instead of permanently caching a
      // rejected load (a transient network blip loading the ~30MB wasm
      // shouldn't take MP4 transcoding down for the rest of the session).
      ffmpegPromise = null;
      throw err;
    });
  }
  return ffmpegPromise;
}

export interface TranscodeOptions {
  onProgress?: (fraction: number) => void;
  /** Fired once, synchronously before the actual transcode starts, if (and
   * only if) ffmpeg.wasm's core hasn't been loaded yet this session.
   * Measured live: instantiating the ~32MB core (fetch is ~150ms; the
   * emscripten module's own init — compiling and linking the bundled
   * libx264/libx265/libvpx/etc — is the actual cost) took ~19s in testing,
   * dwarfing the transcode itself (~4-7s for a short clip). Until this
   * fires "done", nothing resembling "conversion progress" exists yet — the
   * caller should show a distinct "loading" state instead of a frozen 0%,
   * which is what previously made this look permanently stuck. */
  onLoadingChange?: (loading: boolean) => void;
  /** The source recording's real duration, independently known (e.g. from a
   * wall-clock timer kept during recording) rather than read off the Blob.
   * ffmpeg.wasm's own `progress` field is computed from the *input*
   * container's declared duration — but a `MediaRecorder`-produced WebM is
   * written as an open-ended live stream with no Duration/Cues element, so
   * ffmpeg reports "Duration: N/A" and `progress` never leaves 0 even while
   * actively encoding (the transcode finishes fine; the bar just never
   * moves, reading as permanently stuck). When this is provided, progress is
   * computed instead from the event's `time` field — the position actually
   * encoded so far, in microseconds — against this known duration, which
   * stays accurate regardless of what the container header claims. */
  totalDurationMs?: number;
}

/** Live in-flight progress is capped below 100% — measured live: `time`
 * (and ffmpeg's own `progress`) can reach the full known duration while a
 * real double-digit-percent chunk of wall-clock work still remains (10 of
 * ~20s in testing, on a `-movflags +faststart` mux that has to finish
 * writing/relocating the moov atom after the last input frame is consumed).
 * Reserve 1 exclusively for the moment `transcodeToMp4` actually resolves
 * (see below) — otherwise the bar reports "100%" and then visibly does
 * nothing for several more seconds, which reads as stuck the same way a
 * frozen 0% did before this file's other fix. */
export const MAX_LIVE_FRACTION = 0.97;

/** Pure fraction computation, split out from the `ffmpeg.on("progress", ...)`
 * wiring below so it can be unit-tested without spinning up ffmpeg.wasm
 * itself. See `TranscodeOptions.totalDurationMs` for why `time` (the actual
 * encoded position) is preferred over ffmpeg's own `progress` ratio whenever
 * a known-good total duration is available, and clamped/guarded against
 * ffmpeg.wasm's occasional out-of-[0,1] or NaN reports either way. */
export function computeTranscodeFraction(
  event: { progress: number; time: number },
  totalDurationMs?: number
): number | null {
  const knownDurationUs =
    totalDurationMs != null && Number.isFinite(totalDurationMs) && totalDurationMs > 0
      ? totalDurationMs * 1000
      : null;
  const fraction = knownDurationUs != null ? event.time / knownDurationUs : event.progress;
  return Number.isFinite(fraction) ? Math.max(0, Math.min(MAX_LIVE_FRACTION, fraction)) : null;
}

/** Re-encodes an arbitrary source video Blob (VP9/Opus WebM in practice) into
 * a real H.264/AAC MP4. `-pix_fmt yuv420p` is required, not cosmetic — a
 * canvas capture's default chroma subsampling is otherwise wider than most
 * H.264 decoders (Safari/iOS included) accept, which is exactly the kind of
 * "plays nowhere" MP4 this exists to avoid producing. */
export async function transcodeToMp4(source: Blob, opts: TranscodeOptions = {}): Promise<Blob> {
  const { fetchFile } = await import("@ffmpeg/util");
  const needsLoad = !ffmpegLoaded;
  if (needsLoad) opts.onLoadingChange?.(true);
  const ffmpeg = await getFFmpeg();
  if (needsLoad) opts.onLoadingChange?.(false);

  const inputName = "input" + (source.type.includes("webm") ? ".webm" : ".bin");
  const outputName = "output.mp4";

  const onProgress = (event: { progress: number; time: number }) => {
    const fraction = computeTranscodeFraction(event, opts.totalDurationMs);
    if (fraction != null) opts.onProgress?.(fraction);
  };
  ffmpeg.on("progress", onProgress);

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(source));
    const code = await ffmpeg.exec([
      "-i",
      inputName,
      "-c:v",
      "libx264",
      "-preset",
      // "ultrafast", not "veryfast": this runs single-threaded in wasm (no
      // SharedArrayBuffer/cross-origin isolation set up for the -mt core),
      // so encode speed is the whole bottleneck for a long recording —
      // measured taking multiple times realtime for real screen-recording
      // content, meaning a 27-minute take can take the better part of an
      // hour. -crf keeps quality/bitrate roughly constant across presets;
      // "ultrafast" trades compression efficiency (somewhat larger file for
      // the same quality) for the largest available speed win, which is the
      // right trade for a background fallback path the user is waiting on.
      "ultrafast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputName,
    ]);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);

    const data = await ffmpeg.readFile(outputName);
    // Re-wrap in a fresh, plain-ArrayBuffer-backed Uint8Array — ffmpeg.wasm's
    // typed array is generic over ArrayBufferLike (which includes
    // SharedArrayBuffer), and Blob's constructor type only accepts a view
    // backed by a real ArrayBuffer.
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(String(data));
    // The only point that reports a true 1 — see MAX_LIVE_FRACTION above.
    opts.onProgress?.(1);
    return new Blob([bytes], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", onProgress);
    // Best-effort cleanup — the FFmpeg instance (and its virtual FS) is
    // reused across exports within a session, so a failed delete here
    // would otherwise carry stale files into the next transcode.
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
