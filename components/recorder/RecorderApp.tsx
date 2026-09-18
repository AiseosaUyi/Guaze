"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRecorderStore } from "@/lib/store/useRecorderStore";
import { CompositionEngine } from "@/lib/recording/compositor";
import { RecordingSession } from "@/lib/recording/recorder";
import { AudioMixer } from "@/lib/recording/audio";
import { ActivityTracker } from "@/lib/recording/activity";
import { openPipControls, type PipControlsHandle } from "@/lib/recording/pipControls";
import {
  getCameraStream,
  getMicStream,
  getScreenStream,
  listDevices,
  screenAspectFromStream,
  stopStream,
} from "@/lib/recording/capture";
import { ASPECT_RATIOS, QUALITY_PRESETS, computeEffectiveDims, resolveQualityDims } from "@/lib/recording/presets";
import { recommendQuality } from "@/lib/recording/performance";
import { ModeSelectScreen } from "@/components/recorder/ModeSelectScreen";
import { StudioScreen } from "@/components/recorder/StudioScreen";
import { ExportScreen } from "@/components/recorder/ExportScreen";

export function RecorderApp() {
  const stage = useRecorderStore((s) => s.stage);
  const settings = useRecorderStore((s) => s.settings);
  const setStage = useRecorderStore((s) => s.setStage);
  const setDevices = useRecorderStore((s) => s.setDevices);
  const setCapability = useRecorderStore((s) => s.setCapability);
  const setError = useRecorderStore((s) => s.setError);
  const setResult = useRecorderStore((s) => s.setResult);
  const reset = useRecorderStore((s) => s.reset);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<CompositionEngine | null>(null);
  const recorderRef = useRef<RecordingSession>(new RecordingSession());
  const audioMixerRef = useRef<AudioMixer>(new AudioMixer());
  const activityTrackerRef = useRef<ActivityTracker>(new ActivityTracker());
  const pipHandleRef = useRef<PipControlsHandle | null>(null);

  const screenVideoElRef = useRef<HTMLVideoElement | null>(null);
  const cameraVideoElRef = useRef<HTMLVideoElement | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [screenReady, setScreenReady] = useState(false);
  const [canvasDims, setCanvasDims] = useState<{ width: number; height: number }>(() =>
    resolveQualityDims(settings.quality, settings.customQuality)
  );

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const attachVideo = useCallback((stream: MediaStream, kind: "screen" | "camera") => {
    const el = document.createElement("video");
    el.srcObject = stream;
    el.muted = true;
    el.playsInline = true;
    void el.play().catch(() => undefined);
    if (kind === "screen") screenVideoElRef.current = el;
    else cameraVideoElRef.current = el;
    return el;
  }, []);

  // Enter the setup stage: start the camera/mic preview immediately so the
  // user sees exactly what they'll get (PRD §13). Screen capture is
  // requested only when the user actually starts recording.
  useEffect(() => {
    if (stage !== "setup" && stage !== "recording") return;
    if (!canvasRef.current) return;
    if (!compositorRef.current) {
      compositorRef.current = new CompositionEngine(canvasRef.current, settingsRef.current);
      compositorRef.current.start();
    }
    let cancelled = false;
    async function setupCameraPreview() {
      if (settingsRef.current.mode === "screen") return;
      if (cameraStreamRef.current) return;
      try {
        const quality = resolveQualityDims(settingsRef.current.quality, settingsRef.current.customQuality);
        const camStream = await getCameraStream({ width: quality.width, height: quality.height, fps: quality.fps });
        if (cancelled) return stopStream(camStream);
        cameraStreamRef.current = camStream;
        const el = attachVideo(camStream, "camera");
        compositorRef.current?.setSources({
          screenVideo: screenVideoElRef.current,
          cameraVideo: el,
        });
        setCameraReady(true);
        if (settingsRef.current.audio.micEnabled) {
          const mic = await getMicStream({
            deviceId: settingsRef.current.audio.micDeviceId,
            noiseReduction: settingsRef.current.audio.noiseReduction,
          });
          if (cancelled) return stopStream(mic);
          micStreamRef.current = mic;
        }
        const [cameras, mics] = await Promise.all([listDevices("videoinput"), listDevices("audioinput")]);
        if (!cancelled) setDevices({ cameras, mics });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not access the camera or microphone.");
      }
    }
    void setupCameraPreview();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // Resizes the compositor canvas to match the real captured screen's aspect
  // ratio (when a screen source exists) instead of always forcing the
  // quality preset's 16:9 box — otherwise a display that isn't 16:9
  // (MacBook panels are 16:10, ultrawides are 21:9, etc.) gets letterboxed
  // with black bars. Also updates React state so StudioScreen's CSS
  // aspect-ratio matches, keeping the on-screen preview undistorted.
  const applyCanvasDims = useCallback((quality: { width: number; height: number }) => {
    const forcedAspect = ASPECT_RATIOS[settingsRef.current.aspectRatio]?.ratio ?? null;
    const dims = computeEffectiveDims(
      quality,
      screenAspectFromStream(screenStreamRef.current),
      forcedAspect
    );
    compositorRef.current?.resize(dims.width, dims.height);
    setCanvasDims(dims);
  }, []);

  // getDisplayMedia needs a user gesture, so unlike the camera this can't
  // auto-request on mount — it's wired to a button the person clicks
  // during setup. Doing it here (rather than waiting for "Start Recording")
  // means Layout, Format, Zoom/Pan and every other screen-related control
  // has real content to preview against before committing to a take, the
  // same way the camera preview already works. If they never click it,
  // beginRecording()'s own fallback request still covers them.
  const requestScreenPreview = useCallback(async () => {
    if (screenStreamRef.current) return;
    setError(null);
    try {
      const quality = resolveQualityDims(settingsRef.current.quality, settingsRef.current.customQuality);
      const screenStream = await getScreenStream({
        width: quality.width,
        height: quality.height,
        fps: quality.fps,
        withSystemAudio: settingsRef.current.audio.systemAudioEnabled,
        withCursor: settingsRef.current.cursor.visible,
      });
      screenStreamRef.current = screenStream;
      const el = attachVideo(screenStream, "screen");
      compositorRef.current?.setSources({
        screenVideo: el,
        cameraVideo: cameraVideoElRef.current,
      });
      setScreenReady(true);
      applyCanvasDims(resolveQualityDims(settingsRef.current.quality, settingsRef.current.customQuality));
      // Chrome's own "Stop sharing" bar can end this stream without ever
      // touching our UI — treat that the same as never having picked a
      // screen, so the "Choose what to share" prompt comes back instead of
      // leaving a frozen last frame in the preview.
      screenStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (screenStreamRef.current === screenStream) {
          screenStreamRef.current = null;
          setScreenReady(false);
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not access your screen.");
    }
  }, [attachVideo, applyCanvasDims, setError]);

  // Keep the compositor's settings (and canvas resolution) in sync, and log
  // a composition event whenever something changes mid-take.
  useEffect(() => {
    compositorRef.current?.updateSettings(settings);
    applyCanvasDims(resolveQualityDims(settings.quality, settings.customQuality));
    if (recorderRef.current.state === "recording" || recorderRef.current.state === "paused") {
      recorderRef.current.logCompositionEvent("layout", settings);
    }
  }, [settings, applyCanvasDims]);

  useEffect(() => {
    if (stage !== "recording") return;
    const id = window.setInterval(() => setElapsedMs(recorderRef.current.getElapsedMs()), 200);
    return () => window.clearInterval(id);
  }, [stage]);

  // Explicit "point at this moment" trigger — from the floating PiP control
  // (usable while some other window has focus, which is the normal case
  // while sharing) or its in-tab fallback button. Where on screen to zoom
  // isn't known yet here; that's resolved from nearby ActivityTracker
  // samples once the take ends (see smartCamera.ts's createMarkerKeyframe).
  const markZoom = useCallback(() => {
    recorderRef.current.markZoomPoint();
    pipHandleRef.current?.flashMarked();
  }, []);

  const stopRecording = useCallback(async () => {
    setBusy(true);
    try {
      const result = await recorderRef.current.stop();
      const activitySamples = activityTrackerRef.current.stop();
      pipHandleRef.current?.close();
      pipHandleRef.current = null;
      const url = URL.createObjectURL(result.blob);
      setResult({
        url,
        blob: result.blob,
        format: result.format,
        durationMs: result.durationMs,
        activitySamples,
        zoomMarkers: result.zoomMarkers,
      });
      compositorRef.current?.stop();
      stopStream(screenStreamRef.current);
      stopStream(cameraStreamRef.current);
      stopStream(micStreamRef.current);
      screenStreamRef.current = null;
      cameraStreamRef.current = null;
      micStreamRef.current = null;
      setScreenReady(false);
      audioMixerRef.current.dispose();
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish the recording.");
    } finally {
      setBusy(false);
    }
  }, [setResult, setStage, setError]);

  const beginRecording = useCallback(async () => {
    setBusy(true);
    setError(null);
    // Requested first, before any other `await` — Document PiP's
    // requestWindow() requires an active user-gesture "activation" from
    // this click, and getScreenStream()'s own OS picker below can easily
    // consume that activation if this runs after it instead. Resolves to
    // null (never throws) wherever the API isn't available; the in-tab
    // "Mark zoom" button in RecordingHUD still works either way.
    if (!pipHandleRef.current) {
      pipHandleRef.current = await openPipControls({
        onMarkZoom: markZoom,
        onStop: () => void stopRecording(),
      });
    }
    try {
      const quality = resolveQualityDims(settings.quality, settings.customQuality);
      const capability = recommendQuality(settings.quality, settings.background.mode !== "none");
      setCapability(capability.downgraded ? capability : null);
      const effectiveQuality = capability.downgraded && capability.recommended !== "custom"
        ? QUALITY_PRESETS[capability.recommended as keyof typeof QUALITY_PRESETS]
        : quality;

      if (settings.mode !== "camera" && !screenStreamRef.current) {
        const screenStream = await getScreenStream({
          width: effectiveQuality.width,
          height: effectiveQuality.height,
          fps: effectiveQuality.fps,
          withSystemAudio: settings.audio.systemAudioEnabled,
          withCursor: settings.cursor.visible,
        });
        screenStreamRef.current = screenStream;
        const el = attachVideo(screenStream, "screen");
        compositorRef.current?.setSources({
          screenVideo: el,
          cameraVideo: cameraVideoElRef.current,
        });
      }

      applyCanvasDims(effectiveQuality);
      const canvasStream = compositorRef.current!.getStream(effectiveQuality.fps);
      const audioSources = [micStreamRef.current, screenStreamRef.current].filter(
        (s): s is MediaStream => !!s
      );
      const mixedAudioTrack = audioMixerRef.current.mix(audioSources);
      const combined = new MediaStream(canvasStream.getVideoTracks());
      if (mixedAudioTrack) combined.addTrack(mixedAudioTrack);

      recorderRef.current.start(combined, effectiveQuality.videoBitsPerSecond, "mp4");
      // Smart Camera's only input — sampling the same screen <video> element
      // the compositor already reads from, independent of its draw loop.
      // No screen source (camera-only mode) just means no samples, which
      // downstream resolves to "no auto keyframes" rather than an error.
      if (screenVideoElRef.current) {
        activityTrackerRef.current.start(screenVideoElRef.current, () => recorderRef.current.getElapsedMs());
      }
      setPaused(false);
      setElapsedMs(0);
      setStage("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start recording.");
    } finally {
      setBusy(false);
    }
  }, [settings, attachVideo, applyCanvasDims, setStage, setError, setCapability, markZoom, stopRecording]);

  const pauseRecording = useCallback(() => {
    recorderRef.current.pause();
    setPaused(true);
  }, []);
  const resumeRecording = useCallback(() => {
    recorderRef.current.resume();
    setPaused(false);
  }, []);

  // Discard the current take and go again immediately — no trip back to
  // setup, per PRD §16. Streams stay alive so there's no re-prompt.
  const restartRecording = useCallback(() => {
    recorderRef.current.restart();
    setElapsedMs(0);
    setPaused(false);
    void beginRecording();
  }, [beginRecording]);

  // Coming back from the export screen without "Record another" (i.e. the
  // recording streams and compositor were already torn down in
  // stopRecording) needs a fresh CompositionEngine bound to the <canvas>
  // StudioScreen remounts — otherwise the setup effect sees a stale,
  // disposed compositor reference and never rebinds it, and the preview
  // stays blank.
  const backToSetup = useCallback(() => {
    compositorRef.current?.dispose();
    compositorRef.current = null;
    pipHandleRef.current?.close();
    pipHandleRef.current = null;
    setScreenReady(false);
    setStage("setup");
  }, [setStage]);

  const startOver = useCallback(() => {
    compositorRef.current?.dispose();
    compositorRef.current = null;
    pipHandleRef.current?.close();
    pipHandleRef.current = null;
    stopStream(screenStreamRef.current);
    stopStream(cameraStreamRef.current);
    stopStream(micStreamRef.current);
    screenStreamRef.current = null;
    cameraStreamRef.current = null;
    micStreamRef.current = null;
    setCameraReady(false);
    setScreenReady(false);
    reset();
  }, [reset]);

  useEffect(() => {
    const activityTracker = activityTrackerRef.current;
    return () => {
      compositorRef.current?.dispose();
      activityTracker.stop();
      pipHandleRef.current?.close();
      stopStream(screenStreamRef.current);
      stopStream(cameraStreamRef.current);
      stopStream(micStreamRef.current);
    };
  }, []);

  if (stage === "select") return <ModeSelectScreen />;

  if (stage === "review") return <ExportScreen onRecordAgain={startOver} onBackToSetup={backToSetup} />;

  return (
    <StudioScreen
      canvasRef={canvasRef}
      canvasDims={canvasDims}
      recording={stage === "recording"}
      paused={paused}
      elapsedMs={elapsedMs}
      busy={busy}
      cameraReady={cameraReady}
      onStartRecording={() => void beginRecording()}
      onPause={pauseRecording}
      onResume={resumeRecording}
      onStop={() => void stopRecording()}
      onMarkZoom={markZoom}
      onRestart={restartRecording}
      onBack={startOver}
      screenReady={screenReady}
      onRequestScreenPreview={() => void requestScreenPreview()}
    />
  );
}
