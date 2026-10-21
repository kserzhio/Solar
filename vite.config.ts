import { defineConfig, type Plugin } from 'vite';

/**
 * Social previews need absolute URLs. Netlify exposes URL, Vercel exposes
 * VERCEL_PROJECT_PRODUCTION_URL; SITE_URL overrides both. Without any of them the
 * tags fall back to relative paths (fine for local previews).
 */
const raw =
  process.env.SITE_URL ||
  process.env.URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
const base = raw ? raw.replace(/\/?$/, '/') : '';

function siteUrl(): Plugin {
  return {
    name: 'site-url',
    transformIndexHtml: (html) =>
      html
        .replace(/__SITE_URL__/g, base)
        .replace(base ? /(?!)/ : /\s*<meta property="og:url" content="" \/>/, ''),
  };
}

/** The page's Ukrainian texts and their English, for the English copy of index.html. */
const EN_META: [string, string][] = [
  ['<html lang="uk">', '<html lang="en">'],
  ['content="uk_UA"', 'content="en_US"'],
  ['<title>Народження Всесвіту</title>', '<title>Birth of the Universe</title>'],
  ['content="Народження Всесвіту"', 'content="Birth of the Universe"'],
  [
    'content="Кінематографічна інтерактивна візуалізація: від Великого вибуху до Сонячної системи."',
    'content="A cinematic interactive visualisation: from the Big Bang to the Solar System."',
  ],
  [
    'content="13,8 мільярда років за 40 секунд: від Великого вибуху до Сонячної системи. Інтерактивна кінематографічна візуалізація."',
    'content="13.8 billion years in 40 seconds: from the Big Bang to the Solar System. An interactive cinematic visualisation."',
  ],
  [
    'content="13,8 мільярда років за 40 секунд: від Великого вибуху до Сонячної системи."',
    'content="13.8 billion years in 40 seconds: from the Big Bang to the Solar System."',
  ],
  [
    'content="Протопланетний диск молодого Сонця: кільця й щілини, де народжуються планети"',
    'content="The young Sun’s protoplanetary disk: rings and gaps where planets are born"',
  ],
];

/**
 * For search engines and link previews (neither runs the app): an English copy of the page
 * (en.html, which Netlify serves at /en) with its own meta tags, each page pointing to the
 * other with hreflang, plus robots.txt and a sitemap listing both.
 */
function languages(): Plugin {
  const alternates = (self: string) =>
    [
      `<link rel="canonical" href="${self}" />`,
      `<link rel="alternate" hreflang="uk" href="${base}" />`,
      `<link rel="alternate" hreflang="en" href="${base}en" />`,
      `<link rel="alternate" hreflang="x-default" href="${base}" />`,
    ].join('\n    ');
  return {
    name: 'languages',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const page = bundle['index.html'];
      if (!page || page.type !== 'asset') return;
      let uk = String(page.source);
      if (base) uk = uk.replace('</head>', `  ${alternates(base)}\n  </head>`);
      page.source = uk;
      let en = uk;
      for (const [from, to] of EN_META) en = en.split(from).join(to);
      if (base) {
        en = en
          .replace(`<meta property="og:url" content="${base}" />`, `<meta property="og:url" content="${base}en" />`)
          .replace(alternates(base), alternates(`${base}en`));
      }
      this.emitFile({ type: 'asset', fileName: 'en.html', source: en });
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\n${base ? `\nSitemap: ${base}sitemap.xml\n` : ''}`,
      });
      if (base) {
        const today = new Date().toISOString().slice(0, 10);
        const url = (loc: string) =>
          `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n` +
          `    <xhtml:link rel="alternate" hreflang="uk" href="${base}" />\n` +
          `    <xhtml:link rel="alternate" hreflang="en" href="${base}en" />\n  </url>`;
        this.emitFile({
          type: 'asset',
          fileName: 'sitemap.xml',
          source:
            `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
            `${url(base)}\n${url(`${base}en`)}\n</urlset>\n`,
        });
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [siteUrl(), languages()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
