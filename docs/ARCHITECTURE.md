# Architecture

## Runtime shape
Everything runs in the browser tab. No server component beyond serving static
assets. State lives in memory (Zustand) for the session; nothing persists across
reloads in Phase 0 (IndexedDB for in-progress recordings is a Phase 1/2 candidate,
not required for the foundation).

## Data flow

```
getDisplayMedia() ──► screen MediaStream ───────────────┐
                                                          │
getUserMedia(video) ► camera MediaStream                 │
        │                                                │
        ▼                                                │
SegmentationEngine (MediaPipe Image Segmenter, WASM/SIMD)    │
  camera frame ─► person mask ─► background composited    │
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
getDisplayMedia audio (system, optional) ─────────────────────────┤
                                                                  ▼
                                                          RecordingSession
                                                       (MediaRecorder, mixed stream)
                                                                  │
                                                                  ▼
                                                         Blob (webm/mp4) ─► download
```

Screen and camera `MediaStreamTrack`s are kept alive and referenced by the
compositor rather than consumed once — this is what lets composition (position,
size, background, layout) change live without re-requesting permissions or
restarting capture.

## Module map (`lib/recording/`)

- `types.ts` — shared types: `SourceMode`, `BackgroundMode`, `LayoutPreset`,
  `CameraShape`, `QualityPresetId`, `AspectRatioId`, `CompositionEvent`,
  `RecordingSettings`. Single source of truth so UI, engine and store agree.
- `capture.ts` — thin wrappers over `getDisplayMedia` / `getUserMedia` /
  `enumerateDevices`. Owns permission errors and device listing. Never touches
  canvas or recording state.
- `segmentation.ts` — `SegmentationEngine`. Loads the MediaPipe Image Segmenter
  (WASM, `runningMode: "VIDEO"`), runs it against camera video frames, and
  exposes the latest person mask. Falls back to "no segmentation" (background
  mode forced to `none`) if the model fails to load or the device is too slow —
  this must never crash the recording.
- `compositor.ts` — `CompositionEngine`. Owns an offscreen `<canvas>`, a
  `requestAnimationFrame` loop, and pure draw functions per layout. Reads
  current `RecordingSettings` + segmentation output each frame; writes nothing
  back. `getStream()` returns `canvas.captureStream(fps)`.
- `recorder.ts` — `RecordingSession`. Wraps `MediaRecorder` on the composed
  stream (+ mixed audio). Exposes `start/pause/resume/stop/restart`. Appends a
  `CompositionEvent` every time the active layout/background changes mid-take,
  timestamped against recording start — this is the hook Phase 2's mid-recording
  layout switcher writes into, and it's why re-editing a take won't require a
  re-record later.
- `presets.ts` — quality presets (Social/High/Pro/Ultra/Custom) → concrete
  `{width, height, fps, videoBitsPerSecond}`, plus aspect-ratio canvas math and
  per-platform export presets.
- `performance.ts` — cheap device-capability probe (hardware concurrency,
  `navigator.mediaCapabilities` where available, a short warm-up frame timing
  check) that recommends a preset and flags when the user's chosen preset is
  probably unsupported, per the PRD's "inform, then gracefully degrade" rule.

## State (`lib/store/useRecorderStore.ts`)
One Zustand store, split by concern in the type but flat in the store (V1 doesn't
need slices): `stage` (`select` → `setup` → `recording` → `review`), `mode`,
`settings` (background, layout, camera transform, quality, audio), `devices`,
and the live `RecordingSession`/`CompositionEngine` instances (held as refs, not
serialized — they are not plain state).

## Why canvas compositing instead of CSS-layered `getDisplayMedia` of the page
Recording the DOM directly would capture the app's own UI. Compositing screen +
camera onto an offscreen canvas and recording *that* stream is what keeps the
recording controls out of the final video (PRD §14) and is what makes background
replacement and layout changes possible without re-capturing.

## Browser target
Chrome on macOS (Apple Silicon) first, per PRD §24–25. `getDisplayMedia` system
audio, `ImageCapture`, and WebCodecs availability are all checked at runtime and
degrade rather than throw.

## What's deliberately not here yet
Segmentation and compositing both run on the main thread in Phase 0, driven by
one `requestAnimationFrame` loop: MediaPipe's WASM/SIMD build is fast enough
at 720p/1080p on Apple Silicon to make this the right complexity trade for a
foundation, and it's far easier to debug than a worker boundary. Moving
segmentation into a Web Worker (via `MediaStreamTrackProcessor` /
`OffscreenCanvas`, transferring frames instead of copying them) is a concrete
Phase 1 item once 4K/60fps + segmentation together need the headroom — the
`SegmentationEngine` class is already isolated behind a small interface
(`segment(videoFrame) -> mask`) specifically so that move doesn't touch the
compositor or the UI.
