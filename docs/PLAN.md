# Social Screen Recorder — Build Plan

Source: Aise's V1 PRD (Sept 2026). This file is the working phase breakdown. Update
checkboxes as work lands; do not rewrite history, append to it.

## Principles carried through every phase
- Local-first. No account, no login, no cloud upload by default.
- Feels like a camera app, not OBS. Every advanced control is opt-in.
- Never crash on unsupported hardware — degrade the quality preset instead.
- Original screen/camera streams are preserved so composition can change after the fact.

## Phase 0 — Foundation (this build)
Goal: a single working vertical slice — pick a mode, see a live composed preview,
record it, and download a real file. This is what "build the foundation" means here;
it is not the full P0 list from the PRD, but every piece is built to extend into it.

- [x] Next.js 16 / React 19 / TypeScript / Tailwind v4 app scaffolded
- [x] Design system: light / dark / system theme, tokens, primitives
- [ ] Mode select screen (Screen / Camera / Screen + Camera)
- [ ] Capture layer: getDisplayMedia, getUserMedia, device enumeration
- [ ] Background segmentation (MediaPipe Image Segmenter, local, in a Worker): none / blur / image
- [ ] Composition canvas engine: draws screen + processed camera per layout, at the
      chosen resolution/fps, exposes `canvas.captureStream()`
- [ ] Studio screen: live preview, background picker, camera position/size/shape,
      layout presets, quality preset picker, mic/system-audio toggles
- [ ] Recorder engine: MediaRecorder wrapper, pause/resume/restart, composition-event
      log (timestamped layout changes, so a future editor doesn't need a re-record)
- [ ] Minimal recording HUD (timer, pause, stop — never present in the recorded frame)
- [ ] Preview + export screen: resolution / fps / quality preset / format / aspect ratio,
      download to disk
- [ ] Device capability probe with graceful fallback (4K60 → 1080p60 → 1080p30)

## Phase 1 — P0 completion (next)
Everything in the PRD's P0 list not covered above:
- Built-in background library (a handful of tasteful options, not a huge set)
- Background image upload + scale/position/blur/brightness/contrast controls
- Camera shapes (rect / rounded / circle), border, shadow, corner radius, drag-to-position
- Full layout set: Screen Only, Camera Only, Floating, PiP, Side-by-side, Camera Focus, Split
- 24/30/60 fps and 720p/1080p/1440p/4K wired end-to-end with real bitrate targets
- MP4 (H.264) primary export, WebM secondary
- Aspect ratio reframe independent of the source recording (16:9 / 9:16 / 1:1 / 4:5)
- Cursor visibility toggle for screen sources (default on for screen recordings)

## Phase 2 — P1
- System audio capture where the browser/OS allows it, mixed separately from mic
- Noise reduction / AGC / echo cancellation tuning, 48kHz capture
- Multi-clip recording: record in named clips, retake / delete / reorder before export
- Trim start/end per clip
- Destination export presets (X, LinkedIn, TikTok, Reels, YouTube, Shorts)
- Mid-recording layout switching UI (the composition-event log already supports this
  from Phase 0 — this phase adds the control surface)
- Performance-adaptive quality (auto step-down with an on-screen notice)

## Phase 3 — P2 (future, not scoped yet)
AI layout selection, AI cleanup (remove pauses/filler), AI auto-zoom, AI captions,
AI social reframe, cloud sync / sharing / accounts. Explicitly out of scope until
the local-first P0/P1 experience is solid — per the PRD's "most important principle."

## Non-goals for V1
- No timeline-based video editor
- No native macOS app (browser-only, Chrome on Apple Silicon is the target)
- No server-side transcoding or AI processing of camera footage
