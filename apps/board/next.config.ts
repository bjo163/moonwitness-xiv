import type { NextConfig } from 'next';

const apiTarget = process.env.BOARD_API_TARGET ?? 'http://127.0.0.1:3000';
const proxyPrefixes = [
  '/api/:path*',
  '/auth/:path*',
  '/jsonrpc/:path*',
  '/health',
  '/health/:path*',
  '/livez',
  '/readyz',
  '/metrics',
  '/notifications',
  '/notifications/:path*',
  '/whatsapp/:path*',
  '/workflows',
  '/workflows/:path*',
];

const nextConfig: NextConfig = {
  distDir: process.env.MW_BOARD_DIST_DIR ?? '.next',
  output: 'standalone',
  async rewrites() {
    return proxyPrefixes.map((source) => ({ source, destination: `${apiTarget}${source}` }));
  },
  async redirects() {
    return [
      { source: '/profile', destination: '/board/profile', permanent: true },
      { source: '/settings', destination: '/board/settings', permanent: true },
      { source: '/knowledge', destination: '/board/knowledge', permanent: true },
      { source: '/stories/workbench', destination: '/board/stories/workbench', permanent: true },
      { source: '/m/:model/:id', destination: '/board/m/:model/:id', permanent: true },
      { source: '/m/:model', destination: '/board/m/:model', permanent: true },
    ];
  },
};

export default nextConfig;
