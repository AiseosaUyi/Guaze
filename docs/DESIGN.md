# Design System

Reference points: Cap (open source, cap.so) for structural clarity and calm,
light-mode confidence; Screen Studio (screen.studio) for the dark-first,
premium-creator-tool mood. Neither is copied — this is a synthesis, built to
work equally well in light, dark, and system mode, which neither reference
actually does (Cap is light-only, Screen Studio is dark-only).

## Mood
Calm, precise, a little bit "camera app" — not a dashboard. Few colors, real
contrast, generous space around the live preview (it's the product). Controls
recede; the composed frame is always the loudest thing on screen.

## Color tokens (CSS variables, `app/globals.css`)
Neutral base (near-white / near-black, not pure), single accent, no gradients
in UI chrome (gradients are allowed only as a *background preset option* inside
the tool itself, per PRD §7).

| token | light | dark |
|---|---|---|
| `--background` | `oklch(0.99 0 0)` | `oklch(0.14 0.005 285)` |
| `--surface` | `oklch(0.97 0 0)` | `oklch(0.19 0.006 285)` |
| `--surface-raised` | `oklch(1 0 0)` | `oklch(0.23 0.006 285)` |
| `--border` | `oklch(0.90 0 0)` | `oklch(0.28 0.006 285)` |
| `--foreground` | `oklch(0.18 0 0)` | `oklch(0.95 0 0)` |
| `--muted-foreground` | `oklch(0.48 0 0)` | `oklch(0.65 0 0)` |
| `--accent` | `oklch(0.62 0.19 264)` (indigo) | `oklch(0.72 0.17 264)` |
| `--accent-foreground` | `oklch(0.99 0 0)` | `oklch(0.12 0 0)` |
| `--danger` (recording dot / stop) | `oklch(0.58 0.22 25)` | `oklch(0.66 0.20 25)` |
| `--ring` | accent at 45% alpha | accent at 45% alpha |

Implemented as `@theme inline` tokens in Tailwind v4 so every utility
(`bg-background`, `text-foreground`, `border-border`, `bg-accent`, …) just
works, and one `[data-theme]` swap (via `next-themes`, `attribute="class"`)
repaints the whole app. "System" is the default — no explicit choice stamped
on `<html>` until the user picks one.

## Typography
Pure system font stack (`-apple-system, "SF Pro Text", Inter, ui-sans-serif`),
no web font fetch — this is a tool for macOS creators, it should feel native,
not like a marketing site, and it keeps the build from depending on Google
Fonts being reachable at build time.
Scale: `text-sm` for controls/labels, `text-base` for body, `text-2xl`/`text-3xl`
for the two or three screen headlines that exist in the whole app (mode select,
"Your recording is ready"). Numerals (the recording timer) use `tabular-nums`
so they don't jitter.

## Shape & elevation
- Radius scale: `--radius: 0.75rem` (`rounded-xl` default for cards/panels),
  `rounded-full` for pills, toggle groups and the record button.
  Camera frame corner radius is a *user control* (PRD §10), independent of UI radius.
- Shadows: one soft shadow token (`shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)]`
  in light, lower-opacity in dark) used sparingly — floating panels and the
  recording HUD only. Cards inside the studio use a 1px border instead of a
  shadow to stay flat and calm.
- The recording HUD and any floating overlay use a translucent surface
  (`backdrop-blur` + `bg-surface/80`) so it reads as "on glass," not as another
  opaque panel competing with the preview.

## Motion
Short and functional, never decorative: 150–200ms ease-out for panel/state
transitions, a slow 2s pulse on the record dot, spring-based drag for the
camera bubble. `motion` (Framer Motion) is installed for these; most of the
app needs none of it.

## Layout patterns
- **Mode select**: three large cards (Screen / Camera / Screen + Camera), full
  height, minimal chrome — first decision, biggest touch targets.
- **Studio (setup)**: live preview dominates (left/center, largest region on
  screen); a narrow right rail holds background, layout, camera and quality
  controls in grouped cards, each with a one-line label, no jargon by default.
  Advanced encoding controls are collapsed behind a single "Advanced" disclosure
  per PRD §28.
- **Recording HUD**: a small pill, bottom-center, floating over the preview —
  timer, pause, stop. Nothing else. It is rendered *outside* the composition
  canvas so it is structurally impossible for it to end up in the recording.
- **Review/export**: preview on one side, export controls (resolution / fps /
  quality preset / format / aspect ratio) on the other, one primary "Export
  Video" action.

## Iconography
`lucide-react` throughout — one icon set, consistent stroke width (already the
library default), no mixing with emoji in the product UI.

## Accessibility baseline
4.5:1 text contrast minimum in both themes (the tokens above were picked to
clear this), visible focus ring (`--ring`) on every interactive element,
`prefers-reduced-motion` respected by disabling the record-dot pulse and
easing transitions to near-instant.
