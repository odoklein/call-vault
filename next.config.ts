import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Worker (worker.ts) runs as a separate always-on process — see README.
  // This config only serves the API + dashboard, which can run anywhere,
  // including serverless, without affecting rate-limit correctness.
};

export default nextConfig;
