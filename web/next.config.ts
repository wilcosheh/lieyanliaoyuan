import type { NextConfig } from "next";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

const nextConfig: NextConfig = {
  agentRules: false,
  // Web 引用仓库根目录的 src/。追踪根放在仓库根，Vercel 函数包才能带上这些文件。
  outputFileTracingRoot: repoRoot,
  experimental: {
    externalDir: true,
  },
  turbopack: {
    root: repoRoot,
  },
};

export default nextConfig;
