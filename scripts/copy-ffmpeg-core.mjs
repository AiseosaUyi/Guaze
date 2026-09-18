// Copies ffmpeg.wasm's core + worker files into public/ffmpeg/ so they're
// served as plain static assets (matching this app's "static export, no
// server, works offline once loaded" model) instead of depending on a CDN
// or asking a bundler to resolve a worker inside a third-party package.
// Runs on postinstall — public/ffmpeg/ is gitignored, regenerated locally.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "public", "ffmpeg");
mkdirSync(outDir, { recursive: true });

const files = [
  // The ESM build, not UMD: FFmpeg's own worker always runs as
  // `type: "module"` and imports its core with a dynamic `import()`, which
  // can't load a UMD script (no `export` statements for it to resolve).
  ["@ffmpeg/core/dist/esm/ffmpeg-core.js", "ffmpeg-core.js"],
  ["@ffmpeg/core/dist/esm/ffmpeg-core.wasm", "ffmpeg-core.wasm"],
  // worker.js is an ES module loaded with type: "module" — its two relative
  // imports (const.js, errors.js) have to sit right next to it so they
  // resolve against the worker's own script URL once it's served from
  // public/ffmpeg/ rather than node_modules.
  ["@ffmpeg/ffmpeg/dist/esm/worker.js", "worker.js"],
  ["@ffmpeg/ffmpeg/dist/esm/const.js", "const.js"],
  ["@ffmpeg/ffmpeg/dist/esm/errors.js", "errors.js"],
];

for (const [from, to] of files) {
  const src = join(root, "node_modules", from);
  const dest = join(outDir, to);
  copyFileSync(src, dest);
  console.log(`copied ${from} -> public/ffmpeg/${to}`);
}
