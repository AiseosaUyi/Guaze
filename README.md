# Social Screen Recorder

A local-first, browser-based recording studio for screen + camera content —
built for social/creator output, not another OBS. See the PRD digest and
build plan in [`docs/`](docs/):

- [`docs/PLAN.md`](docs/PLAN.md) — phased roadmap (this build is Phase 0: Foundation)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system architecture and module map
- [`docs/DESIGN.md`](docs/DESIGN.md) — design system (light/dark/system, tokens, motion)

## Status

Phase 0 (Foundation) is built: mode select → live camera/background preview →
screen + camera composition with layouts → record (pause/resume/restart) →
export (resolution/fps/quality/format/aspect ratio) → download. See
`docs/PLAN.md` for exactly what's in this phase vs. what's next.

This hasn't been exercised in a real browser session yet (camera/screen
permissions need a human at the keyboard) — that's the first thing to do
before building on top of it further.

## Running it

```bash
npm install
npm run dev
```

Open http://localhost:3000 in **Chrome on Apple Silicon** (the V1 target
browser — see `docs/ARCHITECTURE.md`). You'll be prompted for camera/mic and,
once you hit "Start Recording," screen-share permission.

`npm run build` produces a fully static export in `out/` — this app has no
server component, so that folder can be opened directly or served from
anywhere.

## Stack

Next.js 16 (App Router, static export) · React 19 · TypeScript · Tailwind v4
· Zustand · MediaPipe Tasks Vision (on-device background segmentation) ·
hand-rolled Radix-based UI primitives (no external component registry —
`ui.shadcn.com` wasn't reachable from the build environment, so
`components/ui/*` is written directly rather than generated).

Nothing leaves the device: no accounts, no login, no cloud upload. Recording
and background replacement both run entirely in the browser.
