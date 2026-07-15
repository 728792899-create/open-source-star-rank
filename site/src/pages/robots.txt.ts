import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL('https://728792899-create.github.io/open-source-star-rank/');
  const sitemapPath = `${import.meta.env.BASE_URL.replace(/^\//, '')}sitemap-index.xml`;
  const sitemap = new URL(sitemapPath, `${origin.origin}/`);
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${sitemap}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
