import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // Docker runtime image doesn't need the full node_modules tree.
  output: "standalone",
  allowedDevOrigins: ["solens.app"],
};

export default nextConfig;
