import { defineConfig, type Plugin } from 'vite';

/**
 * Social previews need absolute URLs. Netlify exposes URL, Vercel exposes
 * VERCEL_PROJECT_PRODUCTION_URL; SITE_URL overrides both. Without any of them the
 * tags fall back to relative paths (fine for local previews).
 */
function siteUrl(): Plugin {
  const raw =
    process.env.SITE_URL ||
    process.env.URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  const base = raw ? raw.replace(/\/?$/, '/') : '';
  return {
    name: 'site-url',
    transformIndexHtml: (html) =>
      html
        .replace(/__SITE_URL__/g, base)
        .replace(base ? /(?!)/ : /\s*<meta property="og:url" content="" \/>/, ''),
  };
}

export default defineConfig({
  base: './',
  plugins: [siteUrl()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
