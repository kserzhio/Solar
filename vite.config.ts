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
 * (en.html, served at /en by the rules in vercel.json and netlify.toml) with its own meta tags, each page pointing to the
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

/** Scenes with a page of their own for link previews: the picture is public/og/<name>.jpg. */
const SHARED: { name: string; uk: [string, string]; en: [string, string] }[] = [
  {
    name: 'solar',
    uk: ['Сонячна система', 'Сонце, планети, пояс астероїдів і комети — живі, на справжніх орбітах. Наведіть, клікніть, порівняйте розміри.'],
    en: ['The Solar System', 'The Sun, planets, asteroid belt and comets, alive on their real orbits. Hover, click, compare their sizes.'],
  },
  {
    name: 'gargantua',
    uk: ['Гаргантюа', 'Чорна діра з «Інтерстелара», прорахована світлом: як у кіно і як насправді. Планета Міллер, де година — це сім років.'],
    en: ['Gargantua', 'The black hole from Interstellar, traced ray by ray: as in the film and as in nature. Miller’s planet, where an hour is seven years.'],
  },
  {
    name: 'nucleo',
    uk: ['Перші 3 хвилини', 'Як у перші хвилини після Великого вибуху з’явилися ядра гелію.'],
    en: ['The first 3 minutes', 'How the first helium nuclei formed minutes after the Big Bang.'],
  },
  {
    name: 'supernova',
    uk: ['Наднова', 'Вибух зорі, що розсіює залізо й кисень — те, з чого згодом складемося ми.'],
    en: ['Supernova', 'A star blowing apart and scattering the iron and oxygen we are later made of.'],
  },
  {
    name: 'moon',
    uk: ['Народження Місяця', 'Молода Земля зіштовхується з Теєю, і з уламків збирається Місяць.'],
    en: ['Birth of the Moon', 'The young Earth collides with Theia, and the Moon gathers from the debris.'],
  },
  {
    name: 'pulsar',
    uk: ['Пульсар', 'Нейтронна зоря завбільшки з місто, що обертається сотні разів на секунду, — космічний маяк.'],
    en: ['Pulsar', 'A neutron star the size of a city, spinning hundreds of times a second: a cosmic lighthouse.'],
  },
  {
    name: 'merger',
    uk: ['Злиття чорних дір', 'Дві чорні діри зливаються в одну, і простір бринить гравітаційними хвилями.'],
    en: ['Black hole merger', 'Two black holes become one, and space rings with gravitational waves.'],
  },
  {
    name: 'sunfuture',
    uk: ['Майбутнє Сонця', 'Через 5 мільярдів років: червоний гігант, планетарна туманність і білий карлик.'],
    en: ['The future of the Sun', 'Five billion years from now: a red giant, a planetary nebula and a white dwarf.'],
  },
  {
    name: 'trappist',
    uk: ['TRAPPIST-1', 'Сім планет розміром із Землю навколо червоного карлика. Клікніть будь-яку — подробиці.'],
    en: ['TRAPPIST-1', 'Seven Earth-sized planets round a red dwarf. Click any of them for details.'],
  },
];

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** A page that link previews read (they don't run scripts) and people pass straight through. */
function sharePage(scene: (typeof SHARED)[number], en: boolean): string {
  const [title, text] = en ? scene.en : scene.uk;
  const site = en ? 'Birth of the Universe' : 'Народження Всесвіту';
  const full = `${title} · ${site}`;
  const self = `${base}${en ? 'en/' : ''}s/${scene.name}`;
  const home = base ? `${base}${en ? 'en' : ''}` : en ? '../../en.html' : '../';
  const image = base ? `${base}og/${scene.name}.jpg` : `${en ? '../' : ''}../og/${scene.name}.jpg`;
  const target = `${home}?scene=${scene.name}`;
  return `<!doctype html>
<html lang="${en ? 'en' : 'uk'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escape(full)}</title>
    <meta name="description" content="${escape(text)}" />
    <meta name="robots" content="noindex, follow" />
    ${base ? `<link rel="canonical" href="${home}" />\n    ` : ''}<meta property="og:type" content="website" />
    <meta property="og:locale" content="${en ? 'en_US' : 'uk_UA'}" />
    <meta property="og:site_name" content="${site}" />
    <meta property="og:title" content="${escape(full)}" />
    <meta property="og:description" content="${escape(text)}" />
    ${base ? `<meta property="og:url" content="${self}" />\n    ` : ''}<meta property="og:image" content="${image}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${escape(title)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escape(full)}" />
    <meta name="twitter:description" content="${escape(text)}" />
    <meta name="twitter:image" content="${image}" />
    <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05060a;color:#cfd6e6;font:15px system-ui,sans-serif}a{color:inherit}</style>
    <script>location.replace(${JSON.stringify(target)});</script>
  </head>
  <body>
    <a href="${target}">${escape(title)} →</a>
  </body>
</html>
`;
}

/** s/<scene>.html and en/s/<scene>.html (served at /s/<scene> and /en/s/<scene>). */
function sharePages(): Plugin {
  return {
    name: 'share-pages',
    apply: 'build',
    generateBundle() {
      for (const scene of SHARED) {
        this.emitFile({ type: 'asset', fileName: `s/${scene.name}.html`, source: sharePage(scene, false) });
        this.emitFile({ type: 'asset', fileName: `en/s/${scene.name}.html`, source: sharePage(scene, true) });
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [siteUrl(), languages(), sharePages()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
