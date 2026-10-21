/** Lightweight fallback page for phones, tablets and browsers without WebGL2. No Three.js here. */
import { tr } from './i18n';

const TEXT = {
  mobile: {
    title: 'Всесвіт потребує більшого екрана',
    subtitle: 'Відкрийте цю сторінку на комп’ютері',
  },
  webgl: {
    title: 'Ваш браузер не підтримує WebGL2',
    subtitle: 'Спробуйте свіжу версію Chrome, Edge, Firefox або Safari',
  },
} as const;

export function showStub(root: HTMLElement, reason: 'mobile' | 'webgl'): void {
  const text = { title: tr(TEXT[reason].title), subtitle: tr(TEXT[reason].subtitle) };
  root.innerHTML = `
    <div class="stub">
      <canvas class="stub__stars" aria-hidden="true"></canvas>
      <main class="stub__content">
        <h1 class="stub__title">${text.title}</h1>
        <p class="stub__subtitle">${text.subtitle}</p>
        <button class="stub__button" type="button">${tr('Скопіювати посилання')}</button>
      </main>
    </div>`;

  const button = root.querySelector<HTMLButtonElement>('.stub__button')!;
  button.addEventListener('click', async () => {
    const ok = await copyText(location.href);
    button.textContent = tr(ok ? 'Скопійовано ✓' : 'Не вдалося скопіювати');
    button.classList.add('is-done');
    window.setTimeout(() => {
      button.textContent = 'Скопіювати посилання';
      button.classList.remove('is-done');
    }, 2400);
  });

  startStars(root.querySelector<HTMLCanvasElement>('.stub__stars')!);
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function startStars(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  type Star = { x: number; y: number; r: number; phase: number; speed: number; base: number };
  let stars: Star[] = [];

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    const count = Math.round((window.innerWidth * window.innerHeight) / 2600);
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: (Math.random() ** 3 * 1.3 + 0.35) * dpr,
      phase: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 1.6,
      base: 0.25 + Math.random() * 0.55,
    }));
  };

  const draw = (now: number) => {
    const t = now / 1000;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      const twinkle = still ? 1 : 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
      ctx.globalAlpha = s.base * twinkle;
      ctx.fillStyle = s.r > 1.2 ? '#ffe6c4' : '#cdd8ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!still) requestAnimationFrame(draw);
  };

  resize();
  window.addEventListener('resize', () => {
    resize();
    if (still) draw(0);
  });
  requestAnimationFrame(draw);
}
