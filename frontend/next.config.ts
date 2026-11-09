import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // localhost and 127.0.0.1 are different origins to the dev server; allow both.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
