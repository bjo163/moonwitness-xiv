import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:5173';
  return [
    {
      url: `${siteUrl}/`,
      lastModified: new Date(),
    },
  ];
}
