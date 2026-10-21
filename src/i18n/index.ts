import { EN } from './en';

/**
 * Interface language. The site is written in Ukrainian; English comes from a dictionary
 * keyed by the Ukrainian text (en.ts), looked up where text reaches the screen. English has
 * its own address, /en (a copy of the page with English meta tags, made at build time);
 * ?lang=en works too (and in development), and the choice is kept in localStorage.
 * Ukrainian is the default.
 */
export type Lang = 'uk' | 'en';

/** The English page's address: /en (or en.html), next to the Ukrainian one. */
const EN_PATH = /\/en(\.html)?$/;

function detect(): Lang {
  try {
    if (EN_PATH.test(location.pathname)) {
      localStorage.setItem('lang', 'en');
      return 'en';
    }
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'uk' || q === 'en') {
      localStorage.setItem('lang', q);
      return q;
    }
    const saved = localStorage.getItem('lang');
    if (saved === 'uk' || saved === 'en') return saved;
  } catch {
    // Storage may be blocked; fall back to the default.
  }
  return 'uk';
}

export const lang: Lang = detect();

/** Ukrainian number with a unit, «4,2 св. р.», to English, «4.2 ly». */
const LY = /^([\d  ,.–]+) св\. р\.$/;

/** The text in the current language (Ukrainian text passes through as is). */
export function tr(text: string): string {
  // Text with no Ukrainian in it (numbers, names in Latin) needs nothing.
  if (lang === 'uk' || !/[Ѐ-ӿ]/.test(text)) return text;
  const en = EN[text];
  if (en !== undefined) return en;
  const ly = LY.exec(text);
  if (ly) return `${enNumber(ly[1])} ly`;
  if (import.meta.env.DEV) console.warn('[i18n] no English for:', text);
  return text;
}

/** «1 340» → «1,340», «4,2» → «4.2». */
function enNumber(uk: string): string {
  return uk.trim().replace(/,/g, '.').replace(/[  ](?=\d{3}\b)/g, ',');
}

/** Switches language: the page reloads, so every piece of text follows. */
export function setLang(next: Lang): void {
  try {
    localStorage.setItem('lang', next);
  } catch {
    // The URL carries it anyway.
  }
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  if (import.meta.env.DEV) {
    url.searchParams.set('lang', next);
  } else {
    // The other language's own page, beside this one.
    const dir = url.pathname.replace(EN_PATH, '/').replace(/[^/]*$/, '');
    url.pathname = next === 'en' ? `${dir}en` : dir;
  }
  location.href = url.toString();
}

/** A decimal with the current language's separator. */
export function decimal(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return lang === 'uk' ? s.replace('.', ',') : s;
}

/** Thousands grouped the current language's way. */
export function grouped(n: number): string {
  return Math.round(n).toLocaleString(lang === 'uk' ? 'uk-UA' : 'en-GB');
}
