"use client";

import * as React from "react";
import { ArrowLeft, Download, RotateCcw } from "lucide-react";
import { useRecorderStore } from "@/lib/store/useRecorderStore";
import type { AspectRatioId, ExportFormat, QualityPresetId } from "@/lib/recording/types";
import { ASPECT_RATIOS, QUALITY_PRESETS, resolveQualityDims } from "@/lib/recording/presets";
import { exportRecording } from "@/lib/recording/exporter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { SmartCameraPanel, ZoomRegionOverlay, ZoomTimeline } from "@/components/recorder/ZoomEditor";
import { formatDuration } from "@/lib/utils";

export function ExportScreen({
  onRecordAgain,
  onBackToSetup,
}: {
  onRecordAgain: () => void;
  onBackToSetup: () => void;
}) {
  const result = useRecorderStore((s) => s.result);
  const zoomKeyframes = useRecorderStore((s) => s.zoomKeyframes);
  const updateZoomKeyframe = useRecorderStore((s) => s.updateZoomKeyframe);
  const [quality, setQuality] = React.useState<QualityPresetId>("social");
  const [format, setFormat] = React.useState<ExportFormat>("mp4");
  const [aspect, setAspect] = React.useState<AspectRatioId>("original");
  const [exporting, setExporting] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [progressPhase, setProgressPhase] = React.useState<"recording" | "transcoding">("recording");
  const [exportedUrl, setExportedUrl] = React.useState<string | null>(null);
  const [exportedName, setExportedName] = React.useState("");
  const [exportError, setExportError] = React.useState<string | null>(null);
  const [fallbackNotice, setFallbackNotice] = React.useState<string | null>(null);
  const [selectedZoomId, setSelectedZoomId] = React.useState<string | null>(null);
  const [videoAspect, setVideoAspect] = React.useState<number | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const selectedZoom = zoomKeyframes.find((k) => k.id === selectedZoomId) ?? null;

  if (!result) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground">No recording to export yet.</p>
        <Button onClick={onBackToSetup}>Back to Studio</Button>
      </div>
    );
  }

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    setFallbackNotice(null);
    setProgress(0);
    setProgressPhase("recording");
    try {
      const dims = resolveQualityDims(quality, {
        width: 1920,
        height: 1080,
        fps: 30,
        videoBitsPerSecond: 6_000_000,
      });
      const { blob, fileExtension, outcome } = await exportRecording({
        sourceBlob: result!.blob,
        width: dims.width,
        height: dims.height,
        fps: dims.fps,
        videoBitsPerSecond: dims.videoBitsPerSecond,
        format,
        aspect,
        zoomKeyframes,
        onProgress: (fraction, phase) => {
          setProgress(fraction);
          if (phase) setProgressPhase(phase);
        },
      });
      const url = URL.createObjectURL(blob);
      setExportedUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setExportedName(`recording-${Date.now()}.${fileExtension}`);
      if (outcome === "transcoded-to-mp4") {
        // exportRecording() had to fall back to a slower client-side
        // transcode (ffmpeg.wasm) because this browser's own MP4 encoder
        // can't initialize for this stream — the delivered file IS a real
        // MP4, just worth explaining why export took longer than usual.
        setFallbackNotice(
          `This browser can't record MP4 directly here, so it was converted to a real MP4 after recording — that's why export took a bit longer.`
        );
      } else if (outcome === "webm-fallback") {
        setFallbackNotice(
          `Your browser couldn't encode MP4 here, and the backup MP4 conversion failed too, so this downloaded as WebM instead — plays the same everywhere, just a different container.`
        );
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onBackToSetup}>
            <ArrowLeft /> Back
          </Button>
          <ThemeToggle />
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <h1 className="text-xl font-semibold">Your recording is ready</h1>
          <div
            className="relative max-h-[60vh] w-full max-w-3xl"
            style={videoAspect ? { aspectRatio: `${videoAspect}` } : undefined}
          >
            <video
              ref={videoRef}
              src={result.url}
              controls
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) setVideoAspect(v.videoWidth / v.videoHeight);
              }}
              className="h-full w-full rounded-xl border border-border bg-black shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.08)]"
            />
            {selectedZoom && (
              <ZoomRegionOverlay
                videoRef={videoRef}
                keyframe={selectedZoom}
                onChange={(rect) => updateZoomKeyframe(selectedZoom.id, { rect, source: "manual" })}
              />
            )}
          </div>
          <SmartCameraPanel hasActivity={!!result.activitySamples?.length} />
          <ZoomTimeline
            videoRef={videoRef}
            durationMs={result.durationMs}
            selectedId={selectedZoomId}
            onSelect={setSelectedZoomId}
          />
          <p className="text-xs text-muted-foreground">
            {formatDuration(result.durationMs)} · {result.format.toUpperCase()}
          </p>
          <Button variant="secondary" size="sm" onClick={onRecordAgain}>
            <RotateCcw /> Record another
          </Button>
        </div>
      </div>

      <aside className="w-full shrink-0 space-y-4 border-t border-border p-4 lg:w-80 lg:border-l lg:border-t-0">
        <Card>
          <CardHeader>
            <CardTitle>Export</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Quality</p>
              <div className="space-y-1.5">
                {(Object.keys(QUALITY_PRESETS) as (keyof typeof QUALITY_PRESETS)[]).map((id) => (
                  <button
                    key={id}
                    onClick={() => setQuality(id)}
                    className={`flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                      quality === id
                        ? "border-accent bg-accent text-accent-foreground"
                        : "border-border bg-surface text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span className="font-medium">{QUALITY_PRESETS[id].label}</span>
                    <span className="opacity-80">{QUALITY_PRESETS[id].description}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Format</p>
              <ToggleGroup
                type="single"
                value={format}
                onValueChange={(v) => v && setFormat(v as ExportFormat)}
                className="grid grid-cols-2"
              >
                <ToggleGroupItem value="mp4">MP4</ToggleGroupItem>
                <ToggleGroupItem value="webm">WebM</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Aspect ratio</p>
              <ToggleGroup
                type="single"
                value={aspect}
                onValueChange={(v) => v && setAspect(v as AspectRatioId)}
                className="grid grid-cols-3"
              >
                {(Object.keys(ASPECT_RATIOS) as AspectRatioId[]).map((id) => (
                  <ToggleGroupItem key={id} value={id}>
                    {ASPECT_RATIOS[id].label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            {exportError && <p className="text-xs text-danger">{exportError}</p>}
            {fallbackNotice && <p className="text-xs text-muted-foreground">{fallbackNotice}</p>}

            {!exportedUrl ? (
              <Button className="w-full" onClick={() => void handleExport()} disabled={exporting}>
                {exporting
                  ? `${progressPhase === "transcoding" ? "Converting to MP4" : "Exporting"}… ${Math.round(progress * 100)}%`
                  : "Export Video"}
              </Button>
            ) : (
              <Button className="w-full" asChild>
                <a href={exportedUrl} download={exportedName}>
                  <Download /> Download recording
                </a>
              </Button>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
