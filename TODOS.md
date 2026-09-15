# TODOs

## 🔴 OPEN — Export re-encode pipeline produces an undecodable video (0×0, never plays)

**Where:** `lib/recording/exporter.ts`, `exportRecording()` — the "Export Video"
button on the review screen (`components/recorder/ExportScreen.tsx`).

**Status:** Confirmed real, pre-existing, not yet root-caused. Blocks the
entire export feature (quality/format/aspect conversion), not just the zoom
editor. **Not** caused by the zoom-keyframe feature — see isolation repro below.

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
