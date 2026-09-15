"use client";

import * as React from "react";
import {
  ArrowLeft,
  Camera as CameraIcon,
  ChevronDown,
  Circle,
  Frame as FrameIcon,
  Layers,
  LayoutTemplate,
  Loader2,
  Mic,
  Monitor,
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
  SourceMode,
} from "@/lib/recording/types";
import { BUILTIN_BACKGROUNDS, QUALITY_PRESETS } from "@/lib/recording/presets";
import { Button } from "@/components/ui/button";
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

const MODE_META: Record<SourceMode, { label: string; icon: typeof Monitor }> = {
  screen: { label: "Screen", icon: Monitor },
  camera: { label: "Camera", icon: CameraIcon },
  both: { label: "Screen + Camera", icon: Layers },
};

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
  canvasDims,
  recording,
  paused,
  elapsedMs,
  busy,
  cameraReady,
  onStartRecording,
  onPause,
  onResume,
  onStop,
  onRestart,
  onBack,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Actual compositor canvas resolution — matches the real captured
   * screen's aspect ratio once recording starts, so the preview box isn't
   * forced into the quality preset's fixed 16:9 shape. */
  canvasDims: { width: number; height: number };
  recording: boolean;
  paused: boolean;
  elapsedMs: number;
  busy: boolean;
  cameraReady: boolean;
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
  const updateFrame = useRecorderStore((s) => s.updateFrame);
  const updateBackground = useRecorderStore((s) => s.updateBackground);
  const updateCamera = useRecorderStore((s) => s.updateCamera);
  const setLayout = useRecorderStore((s) => s.setLayout);
  const setQuality = useRecorderStore((s) => s.setQuality);
  const setCursorVisible = useRecorderStore((s) => s.setCursorVisible);
  const updateAudio = useRecorderStore((s) => s.updateAudio);

  const showCamera = settings.mode !== "screen";
  const showScreen = settings.mode !== "camera";
  const showLayoutPicker = settings.mode === "both";
  const modeMeta = MODE_META[settings.mode];
  const waitingForCamera = showCamera && !cameraReady && !recording && !error;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:flex-row">
      <div className="relative flex flex-1 flex-col bg-surface/50 lg:min-h-0">
        <header className="flex items-center justify-between px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onBack} disabled={recording}>
            <ArrowLeft /> Back
          </Button>
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 py-1 text-xs font-medium text-muted-foreground">
            <modeMeta.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
            {modeMeta.label}
          </span>
          <ThemeToggle />
        </header>

        <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4 sm:p-8">
          <div className="relative flex h-full w-full max-w-4xl items-center justify-center">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-6 -z-10 rounded-[2rem] bg-accent/10 blur-3xl dark:bg-accent/15"
            />
            <canvas
              ref={canvasRef}
              className="max-h-full max-w-full rounded-xl border border-border bg-black shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.08)] ring-1 ring-black/5"
              style={{ aspectRatio: `${canvasDims.width} / ${canvasDims.height}` }}
            />
            {waitingForCamera && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl bg-black/70 text-white/90">
                <Loader2 className="h-6 w-6 animate-spin" strokeWidth={1.75} />
                <span className="text-xs font-medium">Waiting for camera access…</span>
              </div>
            )}
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
        <aside className="w-full shrink-0 border-t border-border p-3 lg:w-72 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:p-4">
          <div className="overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-[0_1px_2px_rgba(0,0,0,.03),0_8px_20px_rgba(0,0,0,.05)]">
            <div className="border-b border-border/70 px-3.5 py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Customize
              </span>
            </div>

            <SidebarSection icon={FrameIcon} title="Frame">
              <FrameControls
                enabled={settings.frame.enabled}
                padding={settings.frame.padding}
                cornerRadius={settings.frame.cornerRadius}
                shadow={settings.frame.shadow}
                backdropId={settings.frame.backdropId}
                onChange={updateFrame}
              />
            </SidebarSection>

            {showCamera && (
              <SidebarSection icon={Settings2} title="Background">
                <BackgroundControls
                  mode={settings.background.mode}
                  blurStrength={settings.background.blurStrength}
                  builtinId={settings.background.builtinId}
                  onChange={updateBackground}
                />
              </SidebarSection>
            )}

            {showCamera && (
              <SidebarSection icon={SlidersHorizontal} title="Camera">
                <CameraControls
                  size={settings.camera.size}
                  shape={settings.camera.shape}
                  position={settings.camera.position}
                  border={settings.camera.border}
                  shadow={settings.camera.shadow}
                  cornerRadius={settings.camera.cornerRadius}
                  onChange={updateCamera}
                />
              </SidebarSection>
            )}

            {showLayoutPicker && (
              <SidebarSection icon={LayoutTemplate} title="Layout">
                <ToggleGroup
                  type="single"
                  value={settings.layout}
                  onValueChange={(v) => v && setLayout(v as LayoutPreset)}
                  className="grid grid-cols-2"
                >
                  {LAYOUTS.map((l) => (
                    <ToggleGroupItem key={l.id} value={l.id}>
                      {l.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </SidebarSection>
            )}

            <SidebarSection icon={Sparkles} title="Quality">
              <ToggleGroup
                type="single"
                value={settings.quality}
                onValueChange={(v) => v && setQuality(v as QualityPresetId)}
                className="grid grid-cols-4"
              >
                {(Object.keys(QUALITY_PRESETS) as QualityPresetId[]).map((id) => (
                  <ToggleGroupItem key={id} value={id}>
                    {QUALITY_PRESETS[id as keyof typeof QUALITY_PRESETS].label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="mt-2 text-xs text-muted-foreground">
                {QUALITY_PRESETS[settings.quality as keyof typeof QUALITY_PRESETS]?.description}
              </p>
            </SidebarSection>

            {showScreen && (
              <SidebarSection icon={MonitorPlay} title="Screen">
                <div className="flex items-center justify-between">
                  <Label htmlFor="cursor-visible">Show cursor</Label>
                  <Switch
                    id="cursor-visible"
                    checked={settings.cursor.visible}
                    onCheckedChange={setCursorVisible}
                  />
                </div>
              </SidebarSection>
            )}

            <SidebarSection icon={Mic} title="Audio">
              <div className="space-y-2.5">
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
              </div>
            </SidebarSection>
          </div>
        </aside>
      )}
    </div>
  );
}

function SidebarSection({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5 border-b border-border/70 px-3.5 py-3 last:border-b-0">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        {title}
      </div>
      {children}
    </div>
  );
}

function FrameControls({
  enabled,
  padding,
  cornerRadius,
  shadow,
  backdropId,
  onChange,
}: {
  enabled: boolean;
  padding: number;
  cornerRadius: number;
  shadow: boolean;
  backdropId: string;
  onChange: (partial: Partial<RecordingSettings["frame"]>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="frame-enabled">Padded background</Label>
        <Switch id="frame-enabled" checked={enabled} onCheckedChange={(v) => onChange({ enabled: v })} />
      </div>

      {enabled && (
        <>
          <div className="grid grid-cols-6 gap-2">
            {BUILTIN_BACKGROUNDS.map((bg) => (
              <button
                key={bg.id}
                onClick={() => onChange({ backdropId: bg.id })}
                title={bg.label}
                className={cn(
                  "h-8 rounded-md border-2 transition-colors",
                  backdropId === bg.id ? "border-accent" : "border-transparent"
                )}
                style={{ background: bg.css }}
              />
            ))}
          </div>

          <div className="space-y-1.5">
            <Label>Padding</Label>
            <Slider min={0} max={20} step={1} value={[padding]} onValueChange={([v]) => onChange({ padding: v })} />
          </div>

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

          <div className="flex items-center justify-between">
            <Label htmlFor="frame-shadow">Shadow</Label>
            <Switch id="frame-shadow" checked={shadow} onCheckedChange={(v) => onChange({ shadow: v })} />
          </div>
        </>
      )}
    </div>
  );
}

function BackgroundControls({
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
    <div className="space-y-3">
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
      </div>
  );
}

function CameraControls({
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
  const [moreOpen, setMoreOpen] = React.useState(false);

  return (
    <div className="space-y-3">
        <ToggleGroup
          type="single"
          value={size}
          onValueChange={(v) => v && onChange({ size: v as CameraSizeToken })}
          className="grid grid-cols-4"
        >
          <ToggleGroupItem value="tiny">Tiny</ToggleGroupItem>
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

        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          className="flex w-full items-center justify-between py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Position &amp; style
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", moreOpen && "rotate-180")} />
        </button>

        {moreOpen && (
          <div className="space-y-3 border-t border-border pt-3">
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
          </div>
        )}
    </div>
  );
}
