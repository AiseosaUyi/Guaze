"use client";

import * as React from "react";
import {
  ArrowLeft,
  Circle,
  LayoutTemplate,
  Mic,
  MonitorPlay,
  RectangleHorizontal,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square as SquareIcon,
  Volume2,
} from "lucide-react";
import { useRecorderStore } from "@/lib/store/useRecorderStore";
import type {
  BackgroundMode,
  CameraPosition,
  CameraSizeToken,
  LayoutPreset,
  QualityPresetId,
  RecordingSettings,
} from "@/lib/recording/types";
import { BUILTIN_BACKGROUNDS, QUALITY_PRESETS, resolveQualityDims } from "@/lib/recording/presets";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { RecordingHUD } from "@/components/recorder/RecordingHUD";
import { cn } from "@/lib/utils";

const LAYOUTS: { id: LayoutPreset; label: string }[] = [
  { id: "floating", label: "Floating" },
  { id: "pip", label: "Picture in Picture" },
  { id: "side-by-side", label: "Side by Side" },
  { id: "camera-focus", label: "Camera Focus" },
  { id: "split", label: "Split" },
  { id: "screen-only", label: "Screen Only" },
  { id: "camera-only", label: "Camera Only" },
];

const CAMERA_POSITIONS: CameraPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

export function StudioScreen({
  canvasRef,
  recording,
  paused,
  elapsedMs,
  busy,
  onStartRecording,
  onPause,
  onResume,
  onStop,
  onRestart,
  onBack,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  recording: boolean;
  paused: boolean;
  elapsedMs: number;
  busy: boolean;
  onStartRecording: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRestart: () => void;
  onBack: () => void;
}) {
  const settings = useRecorderStore((s) => s.settings);
  const error = useRecorderStore((s) => s.error);
  const capability = useRecorderStore((s) => s.capability);
  const updateBackground = useRecorderStore((s) => s.updateBackground);
  const updateCamera = useRecorderStore((s) => s.updateCamera);
  const setLayout = useRecorderStore((s) => s.setLayout);
  const setQuality = useRecorderStore((s) => s.setQuality);
  const setCursorVisible = useRecorderStore((s) => s.setCursorVisible);
  const updateAudio = useRecorderStore((s) => s.updateAudio);

  const dims = resolveQualityDims(settings.quality, settings.customQuality);
  const showCamera = settings.mode !== "screen";
  const showScreen = settings.mode !== "camera";
  const showLayoutPicker = settings.mode === "both";

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <div className="relative flex flex-1 flex-col bg-surface/50">
        <header className="flex items-center justify-between px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onBack} disabled={recording}>
            <ArrowLeft /> Back
          </Button>
          <ThemeToggle />
        </header>

        <div className="relative flex flex-1 items-center justify-center p-4 sm:p-8">
          <canvas
            ref={canvasRef}
            className="max-h-full w-full max-w-4xl rounded-xl border border-border bg-black shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.08)]"
            style={{ aspectRatio: `${dims.width} / ${dims.height}` }}
          />
          {recording && (
            <RecordingHUD
              elapsedMs={elapsedMs}
              paused={paused}
              onPause={onPause}
              onResume={onResume}
              onStop={onStop}
            />
          )}
        </div>

        {error && (
          <div className="mx-4 mb-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">
            {error}
          </div>
        )}
        {capability?.downgraded && (
          <div className="mx-4 mb-4 rounded-lg border border-border bg-surface px-4 py-2 text-xs text-muted-foreground">
            {capability.reason}
          </div>
        )}

        <div className="flex items-center justify-center gap-3 px-4 pb-6">
          {!recording ? (
            <Button size="lg" onClick={onStartRecording} disabled={busy}>
              <span className="h-2.5 w-2.5 rounded-full bg-danger-foreground/90" />
              {busy ? "Starting…" : "Start Recording"}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onRestart}>
              <RotateCcw /> Restart
            </Button>
          )}
        </div>
      </div>

      {!recording && (
        <aside className="w-full shrink-0 space-y-4 border-t border-border p-4 lg:w-80 lg:border-l lg:border-t-0 lg:overflow-y-auto">
          {showCamera && (
            <BackgroundCard
              mode={settings.background.mode}
              blurStrength={settings.background.blurStrength}
              builtinId={settings.background.builtinId}
              onChange={updateBackground}
            />
          )}

          {showCamera && (
            <CameraCard
              size={settings.camera.size}
              shape={settings.camera.shape}
              position={settings.camera.position}
              border={settings.camera.border}
              shadow={settings.camera.shadow}
              cornerRadius={settings.camera.cornerRadius}
              onChange={updateCamera}
            />
          )}

          {showLayoutPicker && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <LayoutTemplate className="h-3.5 w-3.5" /> Layout
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-1.5">
                  {LAYOUTS.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => setLayout(l.id)}
                      className={cn(
                        "rounded-md border border-border px-2 py-1.5 text-left text-xs transition-colors",
                        settings.layout === l.id
                          ? "border-accent bg-accent text-accent-foreground"
                          : "bg-surface text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5" /> Quality
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {(Object.keys(QUALITY_PRESETS) as QualityPresetId[]).map((id) => {
                const preset = QUALITY_PRESETS[id as keyof typeof QUALITY_PRESETS];
                return (
                  <button
                    key={id}
                    onClick={() => setQuality(id)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors",
                      settings.quality === id
                        ? "border-accent bg-accent text-accent-foreground"
                        : "bg-surface text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span className="font-medium">{preset.label}</span>
                    <span className="opacity-80">{preset.description}</span>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {showScreen && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MonitorPlay className="h-3.5 w-3.5" /> Screen
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between">
                <Label htmlFor="cursor-visible">Show cursor</Label>
                <Switch
                  id="cursor-visible"
                  checked={settings.cursor.visible}
                  onCheckedChange={setCursorVisible}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mic className="h-3.5 w-3.5" /> Audio
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="mic-enabled">Microphone</Label>
                <Switch
                  id="mic-enabled"
                  checked={settings.audio.micEnabled}
                  onCheckedChange={(v) => updateAudio({ micEnabled: v })}
                />
              </div>
              {showScreen && (
                <div className="flex items-center justify-between">
                  <Label htmlFor="system-audio" className="flex items-center gap-1.5">
                    <Volume2 className="h-3 w-3" /> System audio
                  </Label>
                  <Switch
                    id="system-audio"
                    checked={settings.audio.systemAudioEnabled}
                    onCheckedChange={(v) => updateAudio({ systemAudioEnabled: v })}
                  />
                </div>
              )}
              <div className="flex items-center justify-between">
                <Label htmlFor="noise-reduction">Noise reduction</Label>
                <Switch
                  id="noise-reduction"
                  checked={settings.audio.noiseReduction}
                  onCheckedChange={(v) => updateAudio({ noiseReduction: v })}
                />
              </div>
            </CardContent>
          </Card>
        </aside>
      )}
    </div>
  );
}

function BackgroundCard({
  mode,
  blurStrength,
  builtinId,
  onChange,
}: {
  mode: BackgroundMode;
  blurStrength: "light" | "medium" | "strong";
  builtinId: string | null;
  onChange: (partial: Partial<RecordingSettings["background"]>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="h-3.5 w-3.5" /> Background
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(v) => v && onChange({ mode: v as BackgroundMode })}
          className="grid grid-cols-4"
        >
          <ToggleGroupItem value="none">None</ToggleGroupItem>
          <ToggleGroupItem value="blur">Blur</ToggleGroupItem>
          <ToggleGroupItem value="builtin">Preset</ToggleGroupItem>
          <ToggleGroupItem value="image">Image</ToggleGroupItem>
        </ToggleGroup>

        {mode === "blur" && (
          <ToggleGroup
            type="single"
            value={blurStrength}
            onValueChange={(v) => v && onChange({ blurStrength: v as RecordingSettings["background"]["blurStrength"] })}
            className="grid grid-cols-3"
          >
            <ToggleGroupItem value="light">Light</ToggleGroupItem>
            <ToggleGroupItem value="medium">Medium</ToggleGroupItem>
            <ToggleGroupItem value="strong">Strong</ToggleGroupItem>
          </ToggleGroup>
        )}

        {mode === "builtin" && (
          <div className="grid grid-cols-3 gap-2">
            {BUILTIN_BACKGROUNDS.map((bg) => (
              <button
                key={bg.id}
                onClick={() => onChange({ builtinId: bg.id })}
                title={bg.label}
                className={cn(
                  "h-12 rounded-md border-2 transition-colors",
                  builtinId === bg.id ? "border-accent" : "border-transparent"
                )}
                style={{ background: bg.css }}
              />
            ))}
          </div>
        )}

        {mode === "image" && (
          <label className="flex cursor-pointer items-center justify-center rounded-md border border-dashed border-border py-4 text-xs text-muted-foreground hover:border-accent hover:text-foreground">
            Upload image
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onChange({ imageUrl: URL.createObjectURL(file) });
              }}
            />
          </label>
        )}
      </CardContent>
    </Card>
  );
}

function CameraCard({
  size,
  shape,
  position,
  border,
  shadow,
  cornerRadius,
  onChange,
}: {
  size: CameraSizeToken;
  shape: "rectangle" | "rounded" | "circle";
  position: CameraPosition;
  border: boolean;
  shadow: boolean;
  cornerRadius: number;
  onChange: (partial: Partial<RecordingSettings["camera"]>) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal className="h-3.5 w-3.5" /> Camera
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-surface p-1.5">
          {CAMERA_POSITIONS.map((p) => {
            const [v, h] = p.split("-");
            const row = v === "top" ? 0 : v === "middle" ? 1 : 2;
            const col = h === "left" ? 0 : h === "center" ? 1 : 2;
            return (
              <button
                key={p}
                onClick={() => onChange({ position: p as CameraPosition })}
                style={{ gridRow: row + 1, gridColumn: col + 1 }}
                className={cn(
                  "flex h-6 items-center justify-center rounded",
                  position === p ? "bg-accent" : "hover:bg-surface-raised"
                )}
                aria-label={p}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    position === p ? "bg-accent-foreground" : "bg-muted-foreground"
                  )}
                />
              </button>
            );
          })}
        </div>

        <ToggleGroup
          type="single"
          value={size}
          onValueChange={(v) => v && onChange({ size: v as CameraSizeToken })}
          className="grid grid-cols-3"
        >
          <ToggleGroupItem value="small">Small</ToggleGroupItem>
          <ToggleGroupItem value="medium">Medium</ToggleGroupItem>
          <ToggleGroupItem value="large">Large</ToggleGroupItem>
        </ToggleGroup>

        <ToggleGroup
          type="single"
          value={shape}
          onValueChange={(v) => v && onChange({ shape: v as RecordingSettings["camera"]["shape"] })}
          className="grid grid-cols-3"
        >
          <ToggleGroupItem value="rectangle"><RectangleHorizontal /></ToggleGroupItem>
          <ToggleGroupItem value="rounded"><SquareIcon /></ToggleGroupItem>
          <ToggleGroupItem value="circle"><Circle /></ToggleGroupItem>
        </ToggleGroup>

        {shape === "rounded" && (
          <div className="space-y-1.5">
            <Label>Corner radius</Label>
            <Slider
              min={0}
              max={48}
              step={2}
              value={[cornerRadius]}
              onValueChange={([v]) => onChange({ cornerRadius: v })}
            />
          </div>
        )}

        <div className="flex items-center justify-between">
          <Label htmlFor="camera-border">Border</Label>
          <Switch id="camera-border" checked={border} onCheckedChange={(v) => onChange({ border: v })} />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="camera-shadow">Shadow</Label>
          <Switch id="camera-shadow" checked={shadow} onCheckedChange={(v) => onChange({ shadow: v })} />
        </div>
      </CardContent>
    </Card>
  );
}
