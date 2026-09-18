# TODOs

## 🟢 SHIPPED — Screen preview during setup (see the real view before recording)

**Where:** `components/recorder/RecorderApp.tsx` (`screenReady` state,
`requestScreenPreview`), `components/recorder/StudioScreen.tsx`
(`showScreenPicker`, "Choose what to share" overlay, `screenReady` /
`onRequestScreenPreview` props).

**Why:** direct feedback — "the zoom the pan etc are only useful when
actually recording not before as before i dont even get to see how the
view i would be looking at is." Zoom/Pan/Fit/Layout/Format were all wired
up correctly, but during setup the Screen box in the studio preview showed
nothing real (no screen-share stream exists until recording starts), so
there was no way to judge or tune the composition ahead of time — only the
camera preview was live.

**What changed:** a "Choose what to share" overlay now appears over the
Screen box during setup whenever Screen or Screen + Camera mode is
selected and no screen source has been picked yet (mirrors the existing
"waiting for camera" overlay's styling/pattern). Clicking it calls
`getDisplayMedia()` on that user gesture (screen sharing, unlike camera,
can't be requested automatically on mount) and, once granted, feeds the
live stream into the same preview/compositor path used during actual
recording — so Zoom, Pan, Fit, Layout, and Format can all be tuned against
the real screen content before hitting record. A listener on the shared
track's "ended" event (fired if the user stops sharing via Chrome's own
sharing bar) resets back to the picker overlay. State resets on stop
recording, start over, and back-to-setup so re-entering setup always
re-prompts rather than reusing a stale stream.

Verified with `tsc --noEmit` / `eslint` (clean, both files). Not yet
confirmed live end-to-end — `getDisplayMedia()`'s picker is a native
browser-chrome dialog outside the page, so browser automation can show the
overlay and trigger the picker but can't complete the OS-level selection
itself; needs a real click-through in the user's own browser.

## 🟢 SHIPPED — Zoom-editor discoverability: inline how-to hint text

**Where:** `components/recorder/ZoomEditor.tsx` (`ZoomTimeline`).

**Why:** direct feedback — "im not sure how this click to zoom in on a
place works its not very noticeable maybe a tutorial work through / demo
instailled for new users." The zoom-keyframe editor on the export screen
had no explanation of what to do first; a first-time user had to guess
that "Add zoom at playhead" plus dragging the resulting box/handles was
the whole interaction.

**What changed:** a short `text-xs text-muted-foreground` line right under
the "Zoom" header, with three states depending on what's on the timeline:
no keyframes yet → explains scrubbing to a moment and clicking "Add zoom
at playhead"; keyframes exist but none selected → "Click a segment below
to select it and edit its position, size, or timing"; a keyframe selected
→ explains dragging the highlighted box to move it, a corner to resize it,
and its block below to retime it. Scoped deliberately small (inline text,
not a new onboarding system) since the user's phrasing floated a tutorial/
demo as a maybe, not a firm ask — worth revisiting as a fuller walkthrough
if the inline hint isn't enough in practice.

Verified with `tsc --noEmit` / `eslint` (clean). Not yet tested live.

## 🟢 SHIPPED — Fix "failed encoding" export error (MP4→WebM automatic fallback)

**Where:** `lib/recording/exporter.ts` (`runAttempt` extraction, retry
flow), `components/recorder/ExportScreen.tsx` (`fallbackNotice`).

**Why:** reported directly — "also download isnt working its telling me
failed encoding" — a hard blocker on the core download feature, hit while
investigating the feedback above. Reproduced live: exporting as MP4 threw
during `recorder.start()`.

**What changed:** `recorder.onerror` now surfaces the real
`DOMException` (name + message) instead of a generic string, which is how
the actual root cause was found: `EncodingError — Encoder initialization
failed` — a genuine Chromium bug where `MediaRecorder.isTypeSupported()`
reports an MP4/H.264 codec as supported while the encoder still fails to
initialize at runtime for a canvas+WebAudio stream. There's no reliable
way to pre-check this, so the fix is a retry: the MediaRecorder run/draw
loop was extracted into `runAttempt(format)`, and if the first attempt is
MP4 and fails with an encoding-related error, it automatically retries as
WebM — reusing the same `AudioContext`/`MediaStreamAudioDestinationNode`
(since `createMediaElementSource` can only be called once per video
element) and rewinding the source video before replaying. `ExportScreen`
now shows a plain-language notice when the delivered file isn't the
format that was requested ("Your browser couldn't encode MP4 here, so
this downloaded as WebM instead — plays the same everywhere, just a
different container.").

Verified live end-to-end in the user's own browser: MP4 export fails,
falls back automatically, downloads as WebM, notice renders. This is the
one item in this batch confirmed working start to finish, not just
compiled/rendered.


## 🟢 SHIPPED — Zoom/pan control on top of the screen "Fill" crop

**Where:** `lib/recording/types.ts` (`RecordingSettings.screenView`),
`lib/store/useRecorderStore.ts` (`updateScreenView`), `lib/recording/compositor.ts`
(`zoomedCoverFit()`, wired into `drawScreen`'s cover branch),
`components/recorder/StudioScreen.tsx` (Zoom / Pan horizontal / Pan vertical
sliders under Screen > Fit).

**Why:** the "Fill" crop (previous entry) uses `coverFitSource`'s centered
tightest crop, which for a wide landscape screen composited into a narrow
9:16 canvas keeps only a thin vertical sliver of the screen's width —
confirmed directly from the user's own recording: browser text was cropped
down to a few words per line, "not very usable." Switching to "Full"
(contain) fixes readability but reintroduces the letterboxing the Fill
feature existed to avoid — there was no middle ground.

**What changed:** `zoomedCoverFit()` blends continuously between the
tightest cover crop (zoom 0, current default, unchanged) and full contain
(zoom 1, entire screen visible, letterboxed) with no distortion at any
point in between — it always draws the cropped region at its own true
aspect ratio via `containFitDest` rather than stretching it to fill the
box, so a partial zoom is a partial letterbox, never a warped picture. Pan
(horizontal/vertical, -1..1) shifts which part of the source the crop
window is centered on, and is a no-op once zoom reaches 1 (nothing left to
shift). Exposed as three sliders under Screen > Fit, shown whenever fit
isn't forced to "contain". A "Reset zoom & pan" link appears once either
has moved from its 0 default.

Verified with `tsc --noEmit` / `eslint` (clean) and live in the browser —
the sliders render, move, and update store state with no console errors.
Could not visually confirm the actual crop changing on real screen content
in this pass, same `getDisplayMedia` picker limitation noted in the prior
entry; worth a real check dragging Zoom while screen-sharing.

## 🟢 SHIPPED — Screen recording fills the frame in portrait/square formats

**Where:** `lib/recording/types.ts` (`RecordingSettings.screenFitMode`),
`lib/store/useRecorderStore.ts` (`setScreenFitMode`), `lib/recording/compositor.ts`
(`drawScreen`'s new `fit` param + `coverFitSource` branch, `effectiveScreenFit()`),
`components/recorder/StudioScreen.tsx` (new "Fit" control under Screen).

**Why:** the live-portrait-format feature above still drew the screen source
with `containFitDest` (whole-screen, letterboxed) everywhere, including the
full-bleed Floating/PiP/Screen-Only layouts and Split's top block. In a 9:16
canvas that meant a small landscape rectangle centered in a mostly-black
frame — not the "screen recording fills my phone screen" look every
reference mobile-tutorial video actually has (camera small circle top
corner, screen content edge-to-edge). Flagged as a known gap in the prior
entry; this is the fix, from a direct screenshot comparison against a
reference TikTok video.

**What changed:** new `screenFitMode: "auto" | "contain" | "cover"` setting,
"Fit" control in the Screen sidebar section. "Auto" (default) crops the
screen source to fill (`coverFitSource`, the same function already proven
correct for the camera layer) whenever its box is portrait/near-square —
i.e. whenever that's the shape a mobile-social recording's screen block
actually is — and keeps the original whole-screen letterboxed behavior in
a landscape box, so nothing changes for existing 16:9 users. "Full" and
"Fill" force whole-screen or always-crop respectively, for anyone who needs
every pixel of their screen guaranteed visible (code demos, spreadsheets)
or wants edge-to-edge regardless of format.

Verified with `tsc --noEmit` / `eslint` (clean). Could not visually verify
the actual crop live — `getDisplayMedia()`'s screen/window picker is a
native browser-chrome dialog outside the page, not something browser
automation can click through, so starting a Screen + Camera take from this
pass throws (an `InvalidStateError` from the unresolved picker, unrelated
to this change — confirmed by grepping the source, the string isn't ours).
The underlying crop math is identical to `drawCameraLayer`'s, which *was*
confirmed live (camera fills a 9:16 canvas edge to edge with no gaps) in
the prior entry. Worth a real screen-share take to confirm end to end.

## 🟢 SHIPPED — Live mobile/vertical (portrait) recording format

**Where:** `lib/recording/types.ts` (`RecordingSettings.aspectRatio`),
`lib/store/useRecorderStore.ts` (`setAspectRatio`), `lib/recording/presets.ts`
(`computeEffectiveDims` now takes an optional `forcedAspect`),
`components/recorder/RecorderApp.tsx` (`applyCanvasDims`),
`components/recorder/StudioScreen.tsx` (new "Format" sidebar section),
`lib/recording/compositor.ts` (`drawBoth`'s "split" layout).

**What changed:** aspect ratio used to only exist as a post-recording export
crop (`ExportScreen`'s "Aspect ratio" picker, always cropping a landscape
take). There was no way to actually *record* in a mobile/vertical shape for
Twitter, IG, TikTok, Reels, Shorts, etc. — screen + camera were always
composited into a landscape canvas live, then cropped after.

Added a live "Format" control (Original / 16:9 / 9:16 / 4:5 / 1:1) in the
Studio sidebar, above Frame. Picking a non-"original" ratio now forces the
*live compositor canvas itself* into that shape (`computeEffectiveDims`'s new
`forcedAspect` param takes priority over the auto-detected screen aspect),
so the actual `MediaRecorder` output is already the right shape — not a
crop applied afterward. Camera-only and the floating/PiP camera bubble
already cover-fit into any box, so they look native in portrait with no
changes. The "Split" layout (screen top / camera bottom — the standard
vertical tutorial/reaction format) now uses a 62/38 top/bottom split
instead of 50/50 when the canvas is portrait, so the screen content gets
the room it needs and the camera reads as a reaction band, not equal
billing. "Side by Side" doesn't make sense in a narrow portrait canvas
(two slivers), so it's disabled in the Layout picker whenever the chosen
format is portrait/square, and `setAspectRatio` auto-switches an
already-selected Side-by-Side over to Split so the user never gets stuck
on a layout that just broke.

The zoom-keyframe ("click and zoom") editor on the export screen needed
**no changes** — it already maps its rectangle to the video element's own
bounding box in normalized 0..1 space, so it works correctly on portrait
footage automatically.

Verified with `tsc --noEmit` / `eslint` (both clean) and live in the real
browser via `npm run dev`: switched to 9:16 in Camera mode (canvas actually
went portrait, camera cover-filled it edge to edge), switched to Screen +
Camera with Split (screen block on top ~62%, camera band on bottom ~38%,
both full-width), confirmed Side-by-Side greys out in portrait, and did a
real short recording + export-screen check — the downloaded take's own
`<video>` element reported portrait dimensions (not just the live preview),
and the zoom rectangle overlay tracked it correctly.

## 🟢 RESOLVED — Export re-encode pipeline produces an undecodable video (0×0, never plays)

**Where:** `lib/recording/exporter.ts`, `exportRecording()` — the "Export Video"
button on the review screen (`components/recorder/ExportScreen.tsx`).

**Status:** Confirmed real, pre-existing. Blocks the entire export feature
(quality/format/aspect conversion), not just the zoom editor. **Not** caused
by the zoom-keyframe feature — see isolation repro below.

**Fix applied (see `lib/recording/exporter.ts`):** root cause matched
"not yet tested" step 1 below. `exportRecording()` was combining a
`canvas.captureStream()` video track with an audio track pulled from a
*separate* `video.captureStream()` call into one `MediaStream` fed to a
single `MediaRecorder` — the known-flaky "mixed-source tracks in one
MediaRecorder" Chromium combo named in that step. Replaced the audio route
with a `MediaStreamAudioDestinationNode` fed by `createMediaElementSource`
(the standard reliable pattern for canvas + `<video>`-audio recording),
so the recorder only ever sees a canvas-native video track plus a
Web-Audio-native audio track, never two independently-captured streams.
One behavior change worth knowing: `createMediaElementSource` takes over
the element's audio output, so export now re-encodes silently instead of
audibly playing the take back while it processes.

Verified with `tsc --noEmit` and `eslint` (both clean). Could not run
`next build` or exercise this live in a browser from this pass — worth
a real `npm run dev` / export-button click-through to confirm the fix
holds outside static checks, same as the rest of this file already flags
for anything touching this pipeline.

### Symptom

After clicking "Export Video" and downloading the result:
- The container reports a plausible byte size and a sane `duration` (matches
  the source recording's length).
- But `videoWidth` / `videoHeight` on the decoded `<video>` element are both
  `0`, and `currentTime` never advances past `0` even after calling `.play()`
  and waiting — the video is not actually decodable/playable, despite the
  container-level metadata looking fine.
- Reproduces for both `video/mp4` and `video/webm` output.

### What's confirmed

- The **original, live recording** (`RecordingSession` in `lib/recording/recorder.ts`,
  which records `CompositionEngine`'s `canvas.captureStream()` directly during
  the actual recording) is fine — plays back correctly with correct
  `videoWidth`/`videoHeight` (1920×1080 in testing).
- The bug is specifically in the **separate re-encode pipeline** in
  `exportRecording()`: decode the recorded blob into a `<video>`, redraw it
  frame-by-frame into a canvas (for aspect-ratio cropping / now also zoom), 
  `canvas.captureStream()` that, feed it into a **new** `MediaRecorder`, and
  re-encode.
- The canvas-sourced `MediaStreamTrack` itself correctly reports
  `width`/`height` via `track.getSettings()` *before* encoding — so the
  dimensions are lost somewhere in the encode/mux step, not the source track.
- **Isolated repro without any zoom code** (see script below) reproduces the
  identical failure using only the pipeline shape that already existed before
  the zoom feature was added. This is a pre-existing defect, not a regression
  from the zoom keyframe work.

### Not yet tested (next steps for whoever picks this up)

1. **Audio-track mixing as a suspect.** The pipeline mixes a canvas video
   track with an audio track pulled from `video.captureStream()` on the
   *source* `<video>` element into one constructed `MediaStream`. This
   "combine tracks from different sources into one MediaStream fed to
   MediaRecorder" pattern is a known category of Chromium bugs. Retest the
   repro with a **video-only** stream (drop the audio track entirely) to see
   if that alone fixes playback. This test was in progress when the browser
   tab hung (see Environment note below) and was never completed.
2. Try **explicit codec strings** (e.g. `video/mp4;codecs=avc1.640028,mp4a.40.2`,
   `video/webm;codecs=vp9,opus`) instead of the bare `video/mp4` / `video/webm`
   used in the isolated repro, and see if that changes anything. Note: the
   real `pickMimeType()` in `lib/recording/recorder.ts` *does* pick the
   explicit-codec variant first when supported — the isolated repro below
   used the bare mime type only to work around a browser-extension console
   filter, so this specific combination hasn't actually been tested yet.
3. Check whether this is Chrome-version-specific, and search for existing
   Chromium bug reports on `MediaRecorder` + `canvas.captureStream()` +
   mixed-source audio producing corrupt/undecodable output.
4. If `MediaRecorder` proves fundamentally unreliable for this re-encode
   step, consider **WebCodecs** as an alternative — `exporter.ts` already has
   a doc comment flagging this as a "Phase 1 upgrade" candidate for speed;
   it may turn out to be necessary for correctness too, not just speed.
5. Once fixed, there's no test suite in this repo (`package.json` has no
   test script) — consider whether this warrants adding one, at least a
   manual QA checklist step, since this bug is easy to miss (the console
   errors were silent; the only symptom is a broken output file).

### Isolation repro (paste into the browser console on the review/export screen, after recording something)

```js
document.getElementById('debug-export-check')?.remove();

const original = document.querySelector('video');
const sourceUrl = original.currentSrc;

const video = document.createElement('video');
video.src = sourceUrl;
video.muted = false;
video.playsInline = true;
await new Promise((resolve, reject) => {
  video.onloadedmetadata = resolve;
  video.onerror = () => reject(new Error('load failed'));
});

const canvas = document.createElement('canvas');
canvas.width = 1920;
canvas.height = 1080;
const ctx = canvas.getContext('2d', { alpha: false });
const draw = () => ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, canvas.width, canvas.height);

const canvasStream = canvas.captureStream(30);
const mediaStream = new MediaStream();
canvasStream.getVideoTracks().forEach((t) => mediaStream.addTrack(t));
video.captureStream?.().getAudioTracks().forEach((t) => mediaStream.addTrack(t)); // <- try removing this line per step 1 above

const mimeType = 'video' + '/' + 'mp4'; // also tried 'video/webm', same failure
const recorder = new MediaRecorder(mediaStream, { mimeType, videoBitsPerSecond: 6000000 });
const chunks = [];
recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

let rafId = 0;
const tick = () => { draw(); if (!video.ended) rafId = requestAnimationFrame(tick); };

const resultBlob = await new Promise((resolve, reject) => {
  recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  recorder.onerror = () => reject(new Error('encode failed'));
  video.onended = () => { cancelAnimationFrame(rafId); recorder.stop(); };
  video.play().then(() => { recorder.start(250); rafId = requestAnimationFrame(tick); });
  setTimeout(() => { if (recorder.state === 'recording') { cancelAnimationFrame(rafId); recorder.stop(); } }, 8000);
});

const url = URL.createObjectURL(resultBlob);
const v = document.createElement('video');
v.src = url;
v.muted = true;
document.body.appendChild(v);
await new Promise((resolve) => { v.onloadeddata = resolve; });
await v.play().catch(() => {});
await new Promise((r) => setTimeout(r, 500));
console.log({ size: resultBlob.size, videoWidth: v.videoWidth, videoHeight: v.videoHeight, currentTime: v.currentTime, paused: v.paused });
v.remove();
```

Expect `videoWidth`/`videoHeight` to be `0` and `currentTime` to stay `0` —
that's the bug reproducing.

### Environment note

This was diagnosed on a machine under severe memory pressure (near-zero free
RAM, swap nearly full from many concurrent apps/Chrome tabs/Claude Code
sessions) — the browser tab hung mid-diagnosis on one of the later test
variants. The core finding (0×0 dimensions, video won't advance past
`currentTime: 0`) was captured cleanly before that happened and is very
unlikely to be a memory-pressure artifact (dimension/decode failures aren't
typically caused by memory pressure), but re-running the remaining untested
steps above on a machine with normal headroom would remove any doubt.

### Why this matters

This affects the **existing, already-shipped** "Export Video" feature
(quality preset / format / aspect-ratio conversion) — every export that goes
through `exportRecording()` is suspect, not just recordings with zoom
keyframes applied. The zoom editor UI itself (add/move/resize/delete
keyframes on the timeline, drag the region rectangle) works correctly and is
verified live — only the *final rendered file* from this pipeline is
unverified/likely broken until this bug is fixed.
