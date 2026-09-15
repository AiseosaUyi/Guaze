import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully client-side app (no server APIs, no accounts, local-first by
  // design — see docs/ARCHITECTURE.md). Static export means the finished
  // build is just files: open index.html directly, or serve the `out/`
  // folder from anywhere, with no Node server required at runtime.
  output: "export",
};

export default nextConfig;
