/** @type {import('next').NextConfig} */
const nextConfig = {
  // Long-lived server only. This app spawns `claude` children that outlive the
  // request that started them, holds live run buffers in memory and runs a
  // wall-clock scheduler — none of which survive a serverless invocation, so
  // Vercel and friends are not a deployment target. Run it with `next start`.
  //
  // A containerised deploy would add `output: 'standalone'` here, but that
  // mode is incompatible with `next start`, which is how this runs locally.

  // better-sqlite3 is a native module and must not be bundled.
  serverExternalPackages: ['better-sqlite3'],

  // Lets a second server run against its own build output. `next dev` and
  // `next build` write incompatible artefacts to the same .next by default,
  // so running one while the other's output is in place produces confusing
  // cache errors rather than a clear failure.
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // Two lockfiles exist above this directory; be explicit about which tree
  // is ours so tracing does not walk the whole home folder.
  outputFileTracingRoot: import.meta.dirname,

  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
