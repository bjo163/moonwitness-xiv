import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './global.css';
import { SoundProvider } from '@moonwitness/ui/components/audio';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:5173';

// Next.js route metadata must be exported from the route file alongside its component.
// oxlint-disable-next-line react/only-export-components
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'MoonWitness — Real people. Unfiltered worlds.', template: '%s · MoonWitness' },
  description:
    'A thoughtful workspace for organizing people, stories, knowledge, and the signals that connect them.',
  applicationName: 'MoonWitness',
  openGraph: {
    type: 'website',
    siteName: 'MoonWitness',
    title: 'MoonWitness — Real people. Unfiltered worlds.',
    description: 'A thoughtful workspace for stories, people, and connected knowledge.',
  },
  robots: { index: true, follow: true },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/brand/app-icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/brand/app-icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/brand/app-icon-192.png', sizes: '192x192', type: 'image/png' }],
  },
};

// Next.js viewport metadata is also required to be exported from the root layout.
// oxlint-disable-next-line react/only-export-components
export const viewport: Viewport = { themeColor: '#0d0d0d', colorScheme: 'light dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SoundProvider>{children}</SoundProvider>
      </body>
    </html>
  );
}
