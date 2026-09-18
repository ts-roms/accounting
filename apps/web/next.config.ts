import path from 'node:path';
import type { NextConfig } from 'next';

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Monorepo: trace files from the workspace root so the standalone server carries the workspace packages.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  // A second dev instance (e.g. a verification stack on other ports) must not share .next.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  poweredByHeader: false,
  // Source-level workspace packages compiled by Next.
  transpilePackages: ['@accounting/ui'],
  experimental: {
    // Every screen is a client component that fetches its own data with React
    // Query, so the server payload of a route is a static shell: keep visited
    // routes in the client router cache instead of re-requesting the shell on
    // every navigation (Next's default for dynamic routes is 0 s).
    staleTimes: { dynamic: 300, static: 300 },
  },
  async rewrites() {
    // The browser talks to Next.js only; /api/* is proxied server-side to the
    // NestJS API so auth cookies stay first-party and no secrets reach the client.
    return [{ source: '/api/:path*', destination: `${API_INTERNAL_URL}/api/:path*` }];
  },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

export default nextConfig;
