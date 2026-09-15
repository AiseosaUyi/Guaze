"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRecorderStore } from "@/lib/store/useRecorderStore";
import { CompositionEngine } from "@/lib/recording/compositor";
import { RecordingSession } from "@/lib/recording/recorder";
import { AudioMixer } from "@/lib/recording/audio";
import {
  getCameraStream,
  getMicStream,
  getScreenStream,
  listDevices,
  stopStream,
} from "@/lib/recording/capture";
import { QUALITY_PRESETS, resolveQualityDims } from "@/lib/recording/presets";
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

  const screenVideoElRef = useRef<HTMLVideoElement | null>(null);
  const cameraVideoElRef = useRef<HTMLVideoElement | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);

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

  // Keep the compositor's settings (and canvas resolution) in sync, and log
  // a composition event whenever something changes mid-take.
  useEffect(() => {
    compositorRef.current?.updateSettings(settings);
    const quality = resolveQualityDims(settings.quality, settings.customQuality);
    compositorRef.current?.resize(quality.width, quality.height);
    if (recorderRef.current.state === "recording" || recorderRef.current.state === "paused") {
      recorderRef.current.logCompositionEvent("layout", settings);
    }
  }, [settings]);

  useEffect(() => {
    if (stage !== "recording") return;
    const id = window.setInterval(() => setElapsedMs(recorderRef.current.getElapsedMs()), 200);
    return () => window.clearInterval(id);
  }, [stage]);

  const beginRecording = useCallback(async () => {
    setBusy(true);
    setError(null);
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

      compositorRef.current?.resize(effectiveQuality.width, effectiveQuality.height);
      const canvasStream = compositorRef.current!.getStream(effectiveQuality.fps);
      const audioSources = [micStreamRef.current, screenStreamRef.current].filter(
        (s): s is MediaStream => !!s
      );
      const mixedAudioTrack = audioMixerRef.current.mix(audioSources);
      const combined = new MediaStream(canvasStream.getVideoTracks());
      if (mixedAudioTrack) combined.addTrack(mixedAudioTrack);

      recorderRef.current.start(combined, effectiveQuality.videoBitsPerSecond, "mp4");
      setPaused(false);
      setElapsedMs(0);
      setStage("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start recording.");
    } finally {
      setBusy(false);
    }
  }, [settings, attachVideo, setStage, setError, setCapability]);

  const pauseRecording = useCallback(() => {
    recorderRef.current.pause();
    setPaused(true);
  }, []);
  const resumeRecording = useCallback(() => {
    recorderRef.current.resume();
    setPaused(false);
  }, []);

  const stopRecording = useCallback(async () => {
    setBusy(true);
    try {
      const result = await recorderRef.current.stop();
      const url = URL.createObjectURL(result.blob);
      setResult({ url, blob: result.blob, format: result.format, durationMs: result.durationMs });
      compositorRef.current?.stop();
      stopStream(screenStreamRef.current);
      stopStream(cameraStreamRef.current);
      stopStream(micStreamRef.current);
      screenStreamRef.current = null;
      cameraStreamRef.current = null;
      micStreamRef.current = null;
      audioMixerRef.current.dispose();
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish the recording.");
    } finally {
      setBusy(false);
    }
  }, [setResult, setStage, setError]);

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
    setStage("setup");
  }, [setStage]);

  const startOver = useCallback(() => {
    compositorRef.current?.dispose();
    compositorRef.current = null;
    stopStream(screenStreamRef.current);
    stopStream(cameraStreamRef.current);
    stopStream(micStreamRef.current);
    screenStreamRef.current = null;
    cameraStreamRef.current = null;
    micStreamRef.current = null;
    reset();
  }, [reset]);

  useEffect(() => {
    return () => {
      compositorRef.current?.dispose();
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
      recording={stage === "recording"}
      paused={paused}
      elapsedMs={elapsedMs}
      busy={busy}
      onStartRecording={() => void beginRecording()}
      onPause={pauseRecording}
      onResume={resumeRecording}
      onStop={() => void stopRecording()}
      onRestart={restartRecording}
      onBack={startOver}
    />
  );
}
