import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:5173';
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/login', '/register', '/board'] },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
