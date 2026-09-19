import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

// Next only reads .env from its own project directory. The workspace keeps one
// .env at the root, so pull that in before the config is evaluated.
const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
if (existsSync(rootEnv)) loadEnv({ path: rootEnv });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @recall/shared ships TypeScript source rather than a build step, so the
  // orchestrator and the console cannot drift out of sync behind a stale dist.
  transpilePackages: ["@recall/shared"],
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080",
  },
  // The dev watcher otherwise descends into the pnpm store, which is tens of
  // thousands of directories in a workspace this size. Each one costs a file
  // descriptor, and macOS hands a GUI-launched process 256 of them
  // (`launchctl limit maxfiles`). Past that, watchpack raises EMFILE, the app
  // directory scan comes back empty, and every route 404s while the root layout
  // still renders - a console that looks broken rather than misconfigured.
  //
  // @recall/shared is reached through a symlink, and webpack resolves symlinks
  // to their real path (packages/shared), so it is still watched and still
  // hot-reloads despite the node_modules rule below.
  webpack: (config) => {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ["**/node_modules/**", "**/.next/**", "**/.git/**"],
    };
    return config;
  },
};

export default nextConfig;
