# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

A local-first, browser-based recording studio for screen + camera content — screen/camera capture, live canvas compositing (background replacement, camera bubble, layouts), recording, and export, all client-side. No accounts, no login, no server-side processing; nothing leaves the device. See `README.md` and `docs/` for the full picture:

- `docs/PLAN.md` — phased roadmap (current build is Phase 0: Foundation; check this before assuming a feature is in scope)
- `docs/ARCHITECTURE.md` — system architecture and module map (data-flow diagram, why canvas compositing instead of recording the DOM)
- `docs/DESIGN.md` — design system: color tokens, typography, motion, layout patterns

## Commands

Package manager is pnpm (`packageManager` field, `pnpm-lock.yaml`).

```bash
pnpm dev            # next dev
pnpm build          # next build — static export to out/ (output: "export" in next.config.ts)
pnpm start          # next start
pnpm lint           # eslint
npx tsc --noEmit    # type-check (no dedicated package.json script for this)
```

There is no test suite/runner configured in this repo.

The app has no server component — `pnpm build` produces static files in `out/` that can be opened directly or served from anywhere.

**Target browser: Chrome on macOS (Apple Silicon)** — this is the only environment the app is designed/tested against (`getDisplayMedia` system audio, `ImageCapture`, WebCodecs are feature-detected and degrade rather than throw, but the baseline experience assumes Chrome/macOS).

Camera, mic, and (on Start Recording) screen-share permissions require a human at the keyboard — this can't be exercised in a headless/sandboxed environment.

## Architecture

### Data flow

```
getDisplayMedia() ──► screen MediaStream ───────────────┐
getUserMedia(video) ► camera MediaStream                 │
        │                                                │
        ▼                                                │
SegmentationEngine (MediaPipe Image Segmenter, WASM)     │
  camera frame ─► person mask ─► background composited   │
        │                                                │
        ▼                                                ▼
   processed camera frame              CompositionEngine (canvas, rAF loop)
        └──────────────────────────────────────────────► draws screen + camera
                                                           per active Layout
                                                                  │
                                                                  ▼
                                                    canvas.captureStream(fps)
                                                                  │
getUserMedia(audio) ► mic track ──► AudioMixer (AudioContext) ───┤
getDisplayMedia audio (system, optional) ────────────────────────┤
                                                                  ▼
                                                          RecordingSession
                                                       (MediaRecorder, mixed stream)
                                                                  │
                                                                  ▼
                                                         Blob (webm/mp4) ─► download
```

Screen and camera `MediaStreamTrack`s are kept alive and referenced by the compositor rather than consumed once — this is what lets composition (position, size, background, layout) change live without re-requesting permissions or restarting capture.

**Why canvas compositing instead of recording the DOM directly:** recording the page itself would capture the app's own UI/controls. Compositing screen + camera onto an offscreen canvas and recording *that* stream keeps recording controls out of the final video and is what makes background replacement and live layout changes possible without re-capturing.

### Module map (`lib/recording/`)

- `types.ts` — shared types (`SourceMode`, `BackgroundMode`, `LayoutPreset`, `CameraShape`, `QualityPresetId`, `AspectRatioId`, `CompositionEvent`, `RecordingSettings`) — single source of truth so UI, engine, and store agree.
- `capture.ts` — thin wrappers over `getDisplayMedia` / `getUserMedia` / `enumerateDevices`. Owns permission errors and device listing; never touches canvas or recording state.
- `segmentation.ts` — `SegmentationEngine`: loads the MediaPipe Image Segmenter (WASM, `runningMode: "VIDEO"`), runs it against camera frames, exposes the latest person mask. Falls back to no segmentation (background mode forced to `none`) if the model fails to load or the device is too slow — must never crash the recording.
- `compositor.ts` — `CompositionEngine`: owns the offscreen `<canvas>`, the `requestAnimationFrame` draw loop, and per-layout draw functions. Reads current `RecordingSettings` + segmentation output each frame; writes nothing back. `getStream()` returns `canvas.captureStream(fps)`. Canvas resolution is resized to match the actual captured screen's aspect ratio (via `presets.computeEffectiveDims` + `capture.screenAspectFromStream`), not hardcoded to a fixed 16:9 box — otherwise displays that aren't 16:9 (MacBook panels are 16:10, ultrawides 21:9, etc.) get letterboxed.
- `recorder.ts` — `RecordingSession`: wraps `MediaRecorder` on the composed stream (+ mixed audio). Exposes `start/pause/resume/stop/restart`. Appends a `CompositionEvent` whenever the active layout/background changes mid-take, timestamped against recording start — this is what a future mid-recording layout switcher and a re-edit-without-re-recording flow will read.
- `presets.ts` — quality presets (Social/High/Pro/Ultra/Custom) → concrete `{width, height, fps, videoBitsPerSecond}`; `computeEffectiveDims` adapts a preset's pixel budget to the real screen aspect ratio; per-platform export presets and aspect-ratio definitions (`AspectRatioId`: `original`/`16:9`/`9:16`/`1:1`/`4:5`).
- `performance.ts` — cheap device-capability probe (hardware concurrency, `navigator.mediaCapabilities` where available, a short warm-up frame timing check) that recommends a preset and flags when the chosen preset is probably unsupported — "inform, then gracefully degrade," never crash.
- `exporter.ts` — re-renders a finished recording at a chosen resolution/fps/bitrate/aspect ratio by playing it back into a canvas (cover-fit cropped per target aspect, with any zoom keyframes applied) and re-recording that canvas. This is how one recording produces both a 16:9 YouTube export and a 9:16 TikTok export without re-recording. Also draws a brief "interaction pulse" ring for Smart Camera's `source: "auto"` keyframes, riding along the same crop math so it stays pinned through the zoom-in ease. If `format: "mp4"` was requested and MediaRecorder's own encoder can't initialize for it (a real, observed Chrome/OS limitation — `isTypeSupported()` says yes, `.start()` throws `EncodingError`), falls back to WebM and then to `mp4Fallback.ts`'s client-side transcode so "Export as MP4" still delivers one. `ExportResult.outcome` (`"native" | "transcoded-to-mp4" | "webm-fallback"`) tells the caller which path was actually taken.
- `mp4Fallback.ts` — `transcodeToMp4()`: last-resort client-side WebM→MP4 re-encode via ffmpeg.wasm (`libx264`/`aac`, `-movflags +faststart`), entirely local, no server. Core/worker files are self-hosted from `public/ffmpeg/` (regenerated by `scripts/copy-ffmpeg-core.mjs` on `postinstall`, gitignored) rather than fetched from a CDN, and loaded with fully-qualified URLs — passing a root-relative path breaks under Turbopack because the FFmpeg package's worker resolves it against its own `import.meta.url`, which isn't the page's origin. Lazy-loaded (dynamic `import()`) so the ~30MB wasm is never fetched unless a native MP4 attempt actually fails.
- `pipControls.ts` — `openPipControls()`: a floating, always-on-top "Mark zoom" (+ Stop) control bar via Chrome's Document Picture-in-Picture API, opened right when "Start Recording" is clicked (before any other `await`, since `requestWindow()` needs an active user gesture and `getScreenStream()`'s own OS picker can consume it otherwise). This exists because a same-tab button/hotkey can't receive input while the window being screen-shared has focus — which is the normal case. Built with plain DOM, not React (a handful of static buttons in a separate same-origin `Window`). Feature-detected; resolves to `null` rather than throwing wherever it's unavailable (Safari, older Chrome), and `RecordingHUD.tsx`'s own in-tab "Mark zoom" button is the fallback. `RecordingSession.markZoomPoint()` just logs a timestamp — resolving *where* to zoom happens after the fact via `smartCamera.ts`'s `createMarkerKeyframe`/`resolveZoomMarkers`, which search nearby `ActivityTracker` samples for a detected burst near that moment (or fall back to a centered default). Marker-sourced keyframes are tagged `source: "manual"` and apply regardless of the Smart Camera toggle — they're explicit intent, not inference.
- `audio.ts` — `AudioMixer`: combines mic + system-audio tracks via `AudioContext` into one mixed track for the recorder.
- `activity.ts` — `ActivityTracker`: samples the raw screen `<video>` element on an interval during recording (independent of the compositor's own draw loop) and reduces each frame to a coarse motion grid + row-luminance profile. This is Smart Camera's only input — there's no way to read real click/scroll/cursor-position events out of an arbitrary `getDisplayMedia` stream (opaque pixels, possibly of a different app entirely), so "something happened here" is derived from how the captured pixels actually change over time.
- `smartCamera.ts` — `generateSmartZoomKeyframes()`: a pure, DOM-free function that turns `ActivityTracker`'s samples into the exact same `ZoomKeyframe[]` the manual zoom editor produces (tagged `source: "auto"`). Classifies motion per sample as a localized burst (click/typing — worth punching in on), a coherent full-frame vertical shift (scrolling — deliberately produces *no* keyframe, which is what keeps trackpad momentum/mouse-wheel scrolling from ever reading as a jumpy camera rather than requiring the user to say which device they used), or broad/incoherent motion (a page nav, a video playing — also no keyframe). Nearby bursts merge into one hold instead of flickering between two zoom targets.

### State (`lib/store/useRecorderStore.ts`)

One flat Zustand store (no slices — not needed at this size): `stage` (`select` → `setup` → `recording` → `review`), `settings` (`RecordingSettings` — mode, layout, frame, background, camera transform, quality, audio), `devices`, `capability`, `result` (now also carries `activitySamples`), `zoomKeyframes`, `smartCameraEnabled`/`smartCameraIntensity`. Live `RecordingSession`/`CompositionEngine`/`ActivityTracker` instances are held as refs in `RecorderApp.tsx`, not in the store — they aren't serializable state. `setResult`/`setSmartCameraEnabled`/`setSmartCameraIntensity`/`regenerateSmartCamera` all regenerate only the `zoomKeyframes` entries tagged `source: "auto"` — anything the user added or hand-edited via `ZoomEditor.tsx` (tagged `source: "manual"` on first touch) survives a toggle or intensity change untouched.

### UI

`components/recorder/` holds the four screens (`ModeSelectScreen`, `StudioScreen`, `ExportScreen`) orchestrated by `RecorderApp.tsx`, which owns the media/compositor refs and wires them to the store. `components/ui/` is hand-rolled Radix-based primitives written directly rather than generated (`ui.shadcn.com` wasn't reachable from the build environment) — treat it like any other first-party component, not a vendored/generated directory to avoid touching.

### Design system

Full detail in `docs/DESIGN.md`. Key points: color tokens are CSS variables in `app/globals.css` wired through Tailwind v4 `@theme inline`, theme switching via `next-themes` (`attribute="class"`, "system" is default with nothing stamped on `<html>` until the user picks). Recording HUD renders *outside* the composition canvas so it's structurally impossible for it to end up in the recording.

## Principles (from `docs/PLAN.md`)

- Local-first — no account, no login, no cloud upload by default.
- Feels like a camera app, not OBS — advanced controls are opt-in.
- Never crash on unsupported hardware — degrade the quality preset instead.
- Original screen/camera streams are preserved so composition can change after the fact without re-capturing.
