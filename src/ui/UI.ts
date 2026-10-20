import { gsap } from 'gsap';
import type { Planet } from '../data/planets';
import type { ZoomHud } from '../scenes/CosmicZoom';
import { CURIOUS, type CuriousName } from '../scenes/curious';

export interface UIHandlers {
  onSound(): void;
  onSkip(): void;
  onRestart(): void;
  onRewind(): void;
  onSpeed(value: number): void;
  onCloseCard(): void;
  /** Jump to a point of the film (fraction of the timeline). */
  onSeek(fraction: number): void;
  /** Cosmic age label for a fraction of the timeline. */
  seekLabel(fraction: number): string;
  /** Jump to a cosmic-zoom level (0 = Solar System). */
  onZoomLevel(level: number): void;
  /** Fly back through every zoom level to the Solar System. */
  onZoomHome(): void;
  /** Start or stop the guided tour of the planets. */
  onTour(): void;
  /** Toggle the true-scale size comparison. */
  onCompare(): void;
  /** «Для допитливих»: open the menu, or leave the optional scene that is playing. */
  onCurious(): void;
  /** Play one of the optional scenes. */
  onCuriousScene(name: CuriousName): void;
  /** Toggle «Політ крізь Галактику». */
  onDrift(): void;
}

export interface Tick {
  at: number;
  label: string;
}

const ICON_SOUND_ON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>`;
const ICON_SOUND_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>`;
const ICON_SKIP = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6l7 6-7 6z"/><path d="M12 6l7 6-7 6z"/></svg>`;
const ICON_REWIND = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6l-7 6 7 6z"/><path d="M12 6l-7 6 7 6z"/></svg>`;
const ICON_HOME = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5L12 5l8 6.5"/><path d="M6.5 10v8.5h11V10"/></svg>`;
const ICON_TOUR = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.2"/><ellipse cx="12" cy="12" rx="9" ry="4.2"/><circle cx="20.2" cy="10.4" r="1.1"/></svg>`;
const ICON_SIZES = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="13" r="5"/><circle cx="15.5" cy="14.5" r="3"/><circle cx="20.5" cy="15.5" r="1.6"/></svg>`;
const ICON_CURIOUS = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="1.4"/><ellipse cx="12" cy="12" rx="9" ry="3.4"/><ellipse cx="12" cy="12" rx="9" ry="3.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.4" transform="rotate(-60 12 12)"/></svg>`;
const ICON_DRIFT = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="17" cy="7" r="2.4"/><path d="M15.2 8.8C11 13 7 12 3.5 20.5"/><path d="M14 6.2c-4 0-6.5 3-9 6.3"/><path d="M18.4 9.3c.2 4-2.5 7.2-6.2 10.4"/></svg>`;
const ICON_RESTART = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

export class UI {
  readonly hud = el('div', 'hud');
  private brand = el('div', 'brand', 'Народження Всесвіту');
  private prompt = el('div', 'prompt', 'Натисніть, щоб почати');
  private warning = el('div', 'warning', 'Увага: містить яскраві спалахи світла');
  private caption = el('div', 'caption');
  private soundBtn = el('button', 'btn');
  private skipBtn = el('button', 'btn', `${ICON_SKIP}<span>Пропустити до Сонячної системи</span><kbd>S</kbd>`);
  private restartBtn = el('button', 'btn', `${ICON_RESTART}<span>Почати спочатку</span><kbd>R</kbd>`);
  private rewindBtn = el('button', 'btn is-hidden', `${ICON_REWIND}<span>Назад у часі</span><kbd>B</kbd>`);
  /** One element per timeline caption, so each can animate letter by letter. */
  private captionEls: HTMLElement[] = [];
  private zoomNav = el('nav', 'zoom-nav');
  private zoomItems: HTMLButtonElement[] = [];
  private zoomMarker = el('i', 'zoom-nav__marker');
  private homeBtn = el('button', 'btn zoom-home', `${ICON_HOME}<span>Додому</span><kbd>H</kbd>`);
  private tourBtn = el('button', 'btn is-hidden', `${ICON_TOUR}<span>Екскурсія</span><kbd>T</kbd>`);
  private compareBtn = el('button', 'btn is-hidden', `${ICON_SIZES}<span>Розміри</span><kbd>V</kbd>`);
  private driftBtn = el('button', 'btn is-hidden', `${ICON_DRIFT}<span>Політ</span><kbd>G</kbd>`);
  private compareLayer = el('div', 'zoom-labels compare-labels');
  private curiousBtn = el('button', 'btn is-hidden', `${ICON_CURIOUS}<span>Для допитливих</span><kbd>N</kbd>`);
  private curiousMenu = el('div', 'curious-menu');
  private comparePool: HTMLElement[] = [];
  private photoHint = el('div', 'photo-hint', 'Фото-режим · <kbd>P</kbd> повернути інтерфейс · <kbd>C</kbd> зберегти кадр');
  private history = el('div', 'history');
  private photo = false;
  private historyTl: gsap.core.Timeline | null = null;
  private scaleBar = el('div', 'scale-bar', '<span class="scale-bar__label"></span><i class="scale-bar__line"></i>');
  private zoomLayer = el('div', 'zoom-labels');
  private zoomLabelPool: HTMLElement[] = [];
  private here = el('div', 'here', '<i class="here__ring"></i><i class="here__line"></i><span class="here__label">Ви тут</span>');
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private timeline = el('div', 'timeline');
  private counter = el('div', 'timeline__counter');
  private fill = el('div', 'timeline__fill');
  private head = el('div', 'timeline__head');
  private track = el('div', 'timeline__track');
  private hoverTip = el('div', 'timeline__hover');
  private hoverMark = el('div', 'timeline__ghost');
  private tickLabels: { node: HTMLElement; at: number }[] = [];
  private paused = el('div', 'paused', 'Пауза');
  private finalHint = el('div', 'final-hint', 'Наведіть на планету · клік — подробиці · коліщатко — віддалитися · P — фото');
  private speed = el('label', 'speed');
  private speedInput = document.createElement('input');
  private speedOut = document.createElement('output');
  private label = el('div', 'planet-label');
  private card = el('aside', 'card');
  private barTop = el('div', 'letterbox letterbox--top');
  private barBottom = el('div', 'letterbox letterbox--bottom');
  readonly flashEl = el('div', 'flash');
  readonly veilEl = el('div', 'veil');
  private narrow = el(
    'div',
    'narrow',
    `<div class="narrow__text"><div class="narrow__title">Розширте вікно браузера</div><div class="narrow__sub">Всесвіт не вміщується у вікно, вужче за 1024 пікселі</div></div>`,
  );
  private promptTween?: gsap.core.Tween;

  constructor(parent: HTMLElement, private handlers: UIHandlers) {
    const controls = el('div', 'controls');
    this.soundBtn.type = this.skipBtn.type = this.restartBtn.type = this.rewindBtn.type = this.tourBtn.type = this.homeBtn.type = 'button';
    this.tourBtn.title = 'Екскурсія планетами (T)';
    this.compareBtn.type = 'button';
    this.compareBtn.title = 'Справжні розміри Сонця і планет (V)';
    this.compareBtn.addEventListener('click', () => handlers.onCompare());
    this.driftBtn.type = 'button';
    this.driftBtn.title = 'Політ крізь Галактику: як рухаються Сонце і планети насправді (G)';
    this.driftBtn.addEventListener('click', () => handlers.onDrift());
    this.tourBtn.addEventListener('click', () => handlers.onTour());
    this.homeBtn.title = 'Повернутися до Сонячної системи (H)';
    this.homeBtn.addEventListener('click', () => handlers.onZoomHome());
    this.rewindBtn.title = 'Назад у часі: до Великого вибуху (B)';
    this.soundBtn.title = 'Звук (M)';
    this.skipBtn.title = 'Пропустити до Сонячної системи (S)';
    this.restartBtn.title = 'Почати спочатку (R)';
    this.curiousBtn.type = 'button';
    this.curiousBtn.title = 'Для допитливих: короткі наукові сцени (N)';
    this.curiousBtn.setAttribute('aria-haspopup', 'true');
    this.curiousBtn.setAttribute('aria-expanded', 'false');
    this.curiousBtn.addEventListener('click', () => handlers.onCurious());
    this.curiousMenu.innerHTML = `<div class="curious-menu__title">Для допитливих</div>`;
    CURIOUS.forEach((c, i) => {
      const b = el('button', 'curious-menu__item', `<span><b>${c.title}</b><small>${c.sub}</small></span><kbd>${i + 1}</kbd>`);
      b.type = 'button';
      b.addEventListener('click', () => handlers.onCuriousScene(c.name));
      this.curiousMenu.append(b);
    });
    // A click anywhere else closes the menu.
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node;
      if (this.curiousMenuOpen && !this.curiousMenu.contains(t) && !this.curiousBtn.contains(t)) this.setCuriousMenu(false);
    });
    controls.append(this.soundBtn, this.skipBtn, this.driftBtn, this.compareBtn, this.tourBtn, this.curiousBtn, this.rewindBtn, this.restartBtn);
    this.rewindBtn.addEventListener('click', () => handlers.onRewind());
    this.soundBtn.addEventListener('click', () => handlers.onSound());
    this.skipBtn.addEventListener('click', () => handlers.onSkip());
    this.restartBtn.addEventListener('click', () => handlers.onRestart());
    // Keep Space/Enter from re-triggering a focused button when used as hotkeys.
    controls.querySelectorAll('button').forEach((b) => b.addEventListener('keydown', (e) => e.key === ' ' && e.preventDefault()));
    this.setSound(false);

    this.track.append(this.fill, this.head, this.hoverMark);
    const hit = el('div', 'timeline__hit');
    this.timeline.append(this.counter, this.hoverTip, this.track, hit);
    const fractionAt = (e: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    hit.addEventListener('pointermove', (e) => {
      const f = fractionAt(e);
      this.hoverTip.textContent = handlers.seekLabel(f);
      this.hoverTip.style.left = `${f * 100}%`;
      this.hoverMark.style.left = `${f * 100}%`;
      this.timeline.classList.add('is-hovering');
    });
    hit.addEventListener('pointerleave', () => this.timeline.classList.remove('is-hovering'));
    hit.addEventListener('click', (e) => handlers.onSeek(fractionAt(e)));

    this.speedInput.type = 'range';
    this.speedInput.min = '0';
    this.speedInput.max = '4';
    this.speedInput.step = '0.1';
    this.speedInput.value = '1';
    this.speedInput.setAttribute('aria-label', 'Швидкість обертання орбіт');
    this.speedOut.textContent = '1,0×';
    this.speed.append(document.createTextNode('Швидкість орбіт'), this.speedInput, this.speedOut);
    this.speedInput.addEventListener('input', () => {
      const v = Number(this.speedInput.value);
      this.speedOut.textContent = `${v.toFixed(1).replace('.', ',')}×`;
      handlers.onSpeed(v);
    });
    this.speedInput.addEventListener('keydown', (e) => e.stopPropagation());

    this.card.setAttribute('aria-live', 'polite');
    ['Сонячна система', 'Сусідні зорі', 'Чумацький Шлях', 'Місцева група', 'Космічна павутина', 'Спостережуваний Всесвіт'].forEach((name, i) => {
      const b = el('button', 'zoom-nav__item', `<span>${name}</span><i></i>`);
      b.type = 'button';
      b.addEventListener('click', () => handlers.onZoomLevel(i));
      this.zoomItems.push(b);
      this.zoomNav.append(b);
    });
    this.zoomNav.prepend(this.zoomMarker);
    this.zoomNav.setAttribute('aria-label', 'Масштаб Всесвіту');

    this.hud.append(
      this.brand,
      this.prompt,
      this.warning,
      this.caption,
      this.paused,
      this.finalHint,
      this.timeline,
      this.speed,
      this.zoomLayer,
      this.compareLayer,
      this.zoomNav,
      this.homeBtn,
      this.scaleBar,
      this.card,
      this.history,
      controls,
      this.curiousMenu,
    );
    // The flash sits under the HUD so captions stay readable through the brightest moments.
    parent.append(this.barTop, this.barBottom, this.flashEl, this.hud, this.here, this.label, this.photoHint, this.veilEl, this.narrow);
  }

  // ---------------------------------------------------------------- start screen

  showIntro(): void {
    this.brand.style.opacity = '1';
    this.warning.style.opacity = '1';
    this.promptTween?.kill();
    gsap.set(this.prompt, { opacity: 0 });
    this.promptTween = gsap.to(this.prompt, { opacity: 1, duration: 1.6, delay: 3, ease: 'sine.inOut' });
    this.skipBtn.classList.remove('is-hidden');
  }

  hideIntro(): void {
    this.promptTween?.kill();
    gsap.to(this.prompt, { opacity: 0, duration: 0.4 });
    this.brand.style.opacity = '0';
    this.warning.style.opacity = '0';
  }

  setSound(muted: boolean): void {
    this.soundBtn.innerHTML = `${muted ? ICON_SOUND_OFF : ICON_SOUND_ON}<span>${muted ? 'Звук вимк.' : 'Звук увімк.'}</span><kbd>M</kbd>`;
    this.soundBtn.setAttribute('aria-pressed', String(!muted));
  }

  setPaused(paused: boolean): void {
    this.paused.classList.toggle('is-visible', paused);
  }

  setNarrow(narrow: boolean): void {
    this.narrow.classList.toggle('is-visible', narrow);
  }

  // ---------------------------------------------------------------- captions

  /** Adds a one-line caption to the master timeline so it pauses with everything else. */
  private makeCaption(text: string): { node: HTMLElement; chars: HTMLElement[] } {
    const node = el('div', 'caption caption--letters');
    const chars = [...text].map((c) => {
      const span = el('span', 'ch');
      span.textContent = c === ' ' ? '\u00a0' : c;
      // Hidden until its own turn in the stagger comes.
      span.style.opacity = '0';
      return span;
    });
    node.append(...chars);
    node.style.opacity = '0';
    this.hud.append(node);
    this.captionEls.push(node);
    return { node, chars };
  }

  /**
   * Adds a one-line caption to the master timeline so it pauses with everything else.
   * Letters condense out of a blur one after another, then the line dissolves.
   */
  addCaption(tl: gsap.core.Timeline, text: string, at: number, duration: number): void {
    const { node, chars } = this.makeCaption(text);
    const fade = Math.min(0.9, duration / 3);
    tl.set(node, { opacity: 1 }, at);
    if (this.reducedMotion) {
      tl.fromTo(chars, { opacity: 0 }, { opacity: 1, duration: fade, immediateRender: false }, at);
    } else {
      const spread = Math.min(0.9, duration * 0.35);
      tl.fromTo(
        chars,
        { opacity: 0, filter: 'blur(8px)', y: 5 },
        { opacity: 1, filter: 'blur(0px)', y: 0, duration: 0.55, ease: 'power2.out', stagger: spread / chars.length, immediateRender: false },
        at,
      );
    }
    tl.to(node, { opacity: 0, filter: 'blur(3px)', duration: fade, ease: 'sine.in' }, at + duration - fade);
  }

  private spans(text: string): HTMLElement[] {
    return [...text].map((c) => {
      const span = el('span', 'ch');
      span.textContent = c === ' ' ? '\u00a0' : c;
      span.style.opacity = '0';
      return span;
    });
  }

  /** Closing title card: a large line and a quiet subtitle, letter by letter. */
  addTitle(tl: gsap.core.Timeline, at: number, duration: number): void {
    const node = el('div', 'title-card');
    const big = el('div', 'title-card__big');
    const small = el('div', 'title-card__small');
    const a = this.spans('13,8 мільярда років');
    const b = this.spans('Одна мить — і ми тут');
    big.append(...a);
    small.append(...b);
    node.append(big, small);
    node.style.opacity = '0';
    this.hud.append(node);
    this.captionEls.push(node);
    const blur = this.reducedMotion ? {} : { filter: 'blur(10px)', y: 6 };
    const clear = this.reducedMotion ? {} : { filter: 'blur(0px)', y: 0 };
    tl.set(node, { opacity: 1 }, at);
    tl.fromTo(a, { opacity: 0, ...blur }, { opacity: 1, ...clear, duration: 0.8, ease: 'power2.out', stagger: 0.05, immediateRender: false }, at);
    tl.fromTo(b, { opacity: 0, ...blur }, { opacity: 1, ...clear, duration: 0.6, ease: 'power2.out', stagger: 0.03, immediateRender: false }, at + 1.4);
    tl.to(node, { opacity: 0, filter: 'blur(4px)', duration: 1.4, ease: 'sine.in' }, at + duration - 1.4);
  }

  /** The same title outside the master timeline (after «Пропустити»). */
  showTitle(delay = 0.4, duration = 6.5): void {
    const tl = gsap.timeline();
    this.addTitle(tl, delay, duration);
  }

  /** «Ви тут»: a ring around Earth with a hairline leading to a label. */
  setHere(x: number, y: number, opacity: number): void {
    this.here.style.opacity = opacity.toFixed(3);
    if (opacity > 0.001) this.here.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  /** Cosmic zoom HUD: navigator position, object labels and the scale bar. */
  setZoomHud(h: ZoomHud): void {
    const active = Math.round(h.z);
    this.homeBtn.classList.toggle('is-shown', h.z > 0.15);
    if (h.z > 0.02) this.hideHistory();
    this.zoomItems.forEach((b, i) => b.classList.toggle('is-active', i === active));
    const first = this.zoomItems[0];
    const last = this.zoomItems[this.zoomItems.length - 1];
    if (first && last && first.offsetHeight) {
      const top = first.offsetTop + first.offsetHeight / 2;
      const bottom = last.offsetTop + last.offsetHeight / 2;
      this.zoomMarker.style.transform = `translateY(${(top + (bottom - top) * (h.z / (this.zoomItems.length - 1))).toFixed(1)}px)`;
    }
    // Labels
    while (this.zoomLabelPool.length < h.labels.length) {
      const n = el('div', 'zlabel', '<i></i><b></b><small></small>');
      this.zoomLayer.append(n);
      this.zoomLabelPool.push(n);
    }
    this.zoomLabelPool.forEach((n, i) => {
      const l = h.labels[i];
      if (!l) {
        n.style.opacity = '0';
        return;
      }
      n.className = `zlabel zlabel--${l.kind}${l.left ? ' zlabel--left' : ''}`;
      n.style.opacity = l.opacity.toFixed(3);
      n.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px)`;
      const b = n.querySelector('b')!;
      const sm = n.querySelector('small')!;
      if (b.textContent !== l.text) b.textContent = l.text;
      if (sm.textContent !== (l.sub ?? '')) sm.textContent = l.sub ?? '';
    });
    // Scale bar: pick a round length that fits ~120 px.
    const target = h.auPerPx * 120;
    const ly = 63241;
    let unit = 'а. о.';
    let value = target;
    if (target >= ly * 1e9) { unit = 'млрд св. р.'; value = target / (ly * 1e9); }
    else if (target >= ly * 1e6) { unit = 'млн св. р.'; value = target / (ly * 1e6); }
    else if (target >= ly * 1e3) { unit = 'тис. св. р.'; value = target / (ly * 1e3); }
    else if (target >= ly * 0.5) { unit = 'св. р.'; value = target / ly; }
    const pow = Math.pow(10, Math.floor(Math.log10(value)));
    const nice = [1, 2, 5, 10].map((m) => m * pow).filter((m) => m <= value).pop() ?? pow;
    const px = (nice / value) * 120;
    (this.scaleBar.querySelector('.scale-bar__line') as HTMLElement).style.width = `${px.toFixed(1)}px`;
    const label = `${nice >= 1 ? nice.toLocaleString('uk-UA') : nice.toFixed(1)} ${unit}`;
    const lab = this.scaleBar.querySelector('.scale-bar__label')!;
    if (lab.textContent !== label) lab.textContent = label;
  }

  /** Removes the per-caption elements of a previous timeline. */
  resetCaptions(): void {
    this.captionEls.forEach((n) => {
      gsap.killTweensOf(n);
      n.remove();
    });
    this.captionEls = [];
  }

  showCaption(text: string, hold = 4): void {
    gsap.killTweensOf(this.caption);
    this.caption.textContent = text;
    gsap.fromTo(this.caption, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 1, ease: 'sine.out' });
    gsap.to(this.caption, { opacity: 0, duration: 1.2, delay: hold, ease: 'sine.in' });
  }

  clearCaption(): void {
    gsap.killTweensOf(this.caption);
    gsap.set(this.caption, { opacity: 0 });
    this.captionEls.forEach((n) => {
      gsap.killTweensOf(n);
      n.style.opacity = '0';
    });
  }

  /** Spins the cosmic clock backwards to zero (used by «Назад у часі»). */
  rewindClock(duration: number, label: (fraction: number) => string): Promise<void> {
    const state = { f: 1 };
    return new Promise((resolve) => {
      gsap.to(state, {
        f: 0,
        duration,
        ease: 'power2.in',
        onUpdate: () => this.setTimeline(state.f, label(state.f)),
        onComplete: resolve,
      });
    });
  }

  // ---------------------------------------------------------------- timeline

  setTicks(ticks: Tick[]): void {
    this.tickLabels.forEach((t) => t.node.remove());
    this.track.querySelectorAll('.timeline__tick').forEach((n) => n.remove());
    this.tickLabels = ticks.map((t, i) => {
      const tick = el('div', 'timeline__tick');
      tick.style.left = `${t.at * 100}%`;
      // Alternate rows so neighbouring labels never collide.
      const label = el('div', `timeline__label${i === ticks.length - 1 ? ' is-last' : ''}${i % 2 ? ' is-low' : ''}${i === 0 ? ' is-first' : ''}`);
      label.textContent = t.label;
      label.style.left = `${t.at * 100}%`;
      this.track.append(tick, label);
      return { node: label, at: t.at };
    });
  }

  /** Cinematic bars during the film; they open up when the user takes over. */
  setLetterbox(on: boolean): void {
    this.barTop.classList.toggle('is-on', on);
    this.barBottom.classList.toggle('is-on', on);
  }

  setTimelineVisible(visible: boolean): void {
    this.timeline.classList.toggle('is-visible', visible);
  }

  setTimeline(fraction: number, label: string): void {
    const pct = `${(fraction * 100).toFixed(3)}%`;
    this.fill.style.width = pct;
    this.head.style.left = pct;
    this.counter.style.left = pct;
    this.counter.style.transform = `translateX(${-Math.min(1, Math.max(0, fraction)) * 100}%)`;
    if (this.counter.textContent !== label) this.counter.textContent = label;
    for (const t of this.tickLabels) t.node.classList.toggle('is-passed', fraction >= t.at - 1e-4);
  }

  // ---------------------------------------------------------------- overlays

  flash(reduced: boolean): void {
    gsap.killTweensOf(this.flashEl);
    if (reduced) {
      gsap.fromTo(this.flashEl, { opacity: 0 }, { opacity: 0.22, duration: 0.35, yoyo: true, repeat: 1, ease: 'sine.inOut' });
      return;
    }
    gsap.set(this.flashEl, { opacity: 1 });
    gsap.to(this.flashEl, { opacity: 0, duration: 0.7, delay: 0.15, ease: 'power2.out' });
  }

  veil(opacity: number, duration: number): Promise<void> {
    return new Promise((resolve) => {
      gsap.killTweensOf(this.veilEl);
      gsap.to(this.veilEl, { opacity, duration, ease: 'sine.inOut', onComplete: resolve });
    });
  }

  // ---------------------------------------------------------------- final scene

  setFinal(active: boolean): void {
    this.speed.classList.toggle('is-visible', active);
    this.finalHint.classList.toggle('is-visible', active);
    this.skipBtn.classList.toggle('is-hidden', active);
    this.rewindBtn.classList.toggle('is-hidden', !active);
    this.zoomNav.classList.toggle('is-visible', active);
    if (!active) this.homeBtn.classList.remove('is-shown');
    this.tourBtn.classList.toggle('is-hidden', !active);
    this.compareBtn.classList.toggle('is-hidden', !active);
    this.driftBtn.classList.toggle('is-hidden', !active);
    if (!active) this.setDrift(false);
    this.curiousBtn.classList.toggle('is-hidden', !active);
    if (!active) this.setCompare(false);
    if (!active) this.setCurious(false);
    if (!active) this.setTour(false);
    if (!active) this.hideHistory();
    this.scaleBar.classList.toggle('is-visible', active);
    if (!active) this.setZoomHud({ z: 0, labels: [], auPerPx: 1 });
    if (!active) {
      this.speedInput.value = '1';
      this.speedOut.textContent = '1,0×';
      this.hideCard();
      this.showLabel(null);
    }
  }

  showLabel(name: string | null): void {
    if (name) this.label.textContent = name;
    this.label.classList.toggle('is-visible', !!name);
  }

  moveLabel(x: number, y: number): void {
    this.label.style.transform = `translate(${x + 18}px, ${y - 12}px)`;
  }

  showCard(p: Planet): void {
    this.hideHistory();
    this.card.innerHTML = `
      <button class="card__close" type="button" aria-label="Закрити">×</button>
      <div class="card__kicker">${p.kicker}</div>
      <h2 class="card__name">${p.name}</h2>
      <dl class="card__rows">
        <dt>Діаметр</dt><dd>${p.diameter}</dd>
        <dt>Відстань від Сонця</dt><dd>${p.distance}</dd>
        <dt>Тривалість доби</dt><dd>${p.day}</dd>
        <dt>Тривалість року</dt><dd>${p.year}</dd>
        <dt>Супутники</dt><dd>${p.moons}</dd>
      </dl>
      <p class="card__fact">${p.fact}</p>
      <div class="card__hint">Esc або клік поза карткою — назад</div>`;
    this.card.querySelector('.card__close')!.addEventListener('click', () => this.handlers.onCloseCard());
    this.card.classList.add('is-visible');
    this.finalHint.classList.remove('is-visible');
  }

  hideCard(): void {
    this.card.classList.remove('is-visible');
  }

  showFinalHint(visible: boolean): void {
    this.finalHint.classList.toggle('is-visible', visible);
  }

  /** Size comparison mode: hides the zoom and orbit controls, relabels the button. */
  setCompare(on: boolean): void {
    document.body.classList.toggle('is-comparing', on);
    this.compareBtn.classList.toggle('is-on', on);
    (this.compareBtn.querySelector('span') as HTMLElement).textContent = on ? 'Назад' : 'Розміри';
    if (!on) this.setCompareLabels([]);
  }

  setCompareLabels(labels: { x: number; y: number; text: string; sub: string }[]): void {
    while (this.comparePool.length < labels.length) {
      const n = el('div', 'zlabel zlabel--object zlabel--below', '<i></i><b></b><small></small>');
      this.compareLayer.append(n);
      this.comparePool.push(n);
    }
    this.comparePool.forEach((n, i) => {
      const l = labels[i];
      if (!l) {
        n.style.opacity = '0';
        return;
      }
      n.style.opacity = '1';
      n.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px)`;
      const b = n.querySelector('b')!;
      const sm = n.querySelector('small')!;
      if (b.textContent !== l.text) b.textContent = l.text;
      if (sm.textContent !== l.sub) sm.textContent = l.sub;
    });
  }

  setDrift(on: boolean): void {
    this.driftBtn.classList.toggle('is-on', on);
    (this.driftBtn.querySelector('span') as HTMLElement).textContent = on ? 'Зупинити' : 'Політ';
  }

  setTour(on: boolean): void {
    this.tourBtn.classList.toggle('is-on', on);
    (this.tourBtn.querySelector('span') as HTMLElement).textContent = on ? 'Зупинити' : 'Екскурсія';
  }

  // ---------------------------------------------------------------- for the curious

  get curiousMenuOpen(): boolean {
    return this.curiousMenu.classList.contains('is-open');
  }

  setCuriousMenu(open: boolean): void {
    if (open) this.hideHistory();
    this.curiousMenu.classList.toggle('is-open', open);
    this.curiousBtn.setAttribute('aria-expanded', String(open));
  }

  /** While an optional scene plays: the Solar System controls step aside, the button reads «Назад». */
  setCurious(on: boolean): void {
    this.setCuriousMenu(false);
    document.body.classList.toggle('is-curious', on);
    this.curiousBtn.classList.toggle('is-on', on);
    (this.curiousBtn.querySelector('span') as HTMLElement).textContent = on ? 'Назад' : 'Для допитливих';
    this.curiousBtn.title = on ? 'Повернутися до Сонячної системи (Esc)' : 'Для допитливих: короткі наукові сцени (N)';
  }

  // ---------------------------------------------------------------- photo mode

  get photoMode(): boolean {
    return this.photo;
  }

  /** Hides every piece of interface so the frame can be enjoyed (or saved) clean. */
  setPhotoMode(on: boolean): void {
    this.photo = on;
    document.body.classList.toggle('photo-mode', on);
    gsap.killTweensOf(this.photoHint);
    if (on) {
      gsap.fromTo(this.photoHint, { opacity: 0 }, { opacity: 1, duration: 0.5 });
      gsap.to(this.photoHint, { opacity: 0, duration: 1, delay: 3.2 });
    } else {
      gsap.set(this.photoHint, { opacity: 0 });
    }
  }

  // ---------------------------------------------------------------- history of everything

  /**
   * After the first full showing: the whole 13.8 billion years as one line, with the
   * moments that led to us, and how late «we» appear on it.
   */
  showHistory(): void {
    const AGE = 13.8;
    const marks = [
      { at: 0, text: 'Великий вибух', cls: 'history__mark--start' },
      { at: 0.2, text: 'Перші зорі', cls: 'history__mark--low history__mark--start' },
      { at: 9.2, text: 'Сонце і Земля', cls: '' },
      { at: 10.0, text: 'Перше життя', cls: 'history__mark--low' },
      { at: 13.57, text: 'Динозаври', cls: 'history__mark--low' },
    ];
    this.history.innerHTML = `
      <div class="history__title">13,8 мільярда років в одній лінії</div>
      <div class="history__bar"><i class="history__fill"></i>
        ${marks.map((m) => `<span class="history__mark ${m.cls}" style="left:${((m.at / AGE) * 100).toFixed(2)}%"><b>${m.text}</b></span>`).join('')}
        <span class="history__mark history__mark--us history__mark--end" style="left:100%"><b>Ми</b></span>
      </div>
      <div class="history__note">Якби історія Всесвіту тривала один рік, люди з'явилися б 31 грудня — за 11 хвилин до опівночі</div>`;
    const fill = this.history.querySelector('.history__fill') as HTMLElement;
    const items = this.history.querySelectorAll('.history__mark');
    const note = this.history.querySelector('.history__note') as HTMLElement;
    const title = this.history.querySelector('.history__title') as HTMLElement;
    this.historyTl?.kill();
    const tl = gsap.timeline({ onComplete: () => void (this.historyTl = null) });
    this.historyTl = tl;
    tl.set(this.history, { opacity: 1, display: 'block' });
    tl.fromTo(title, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.9, ease: 'sine.out' });
    tl.fromTo(fill, { scaleX: 0 }, { scaleX: 1, duration: this.reducedMotion ? 0.6 : 3.2, ease: 'power1.inOut' }, 0.4);
    items.forEach((n, i) => {
      const at = Number((n as HTMLElement).style.left.replace('%', '')) / 100;
      tl.fromTo(n, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: 0.6, ease: 'sine.out' }, 0.4 + at * (this.reducedMotion ? 0.6 : 3.2) + (i === items.length - 1 ? 0.3 : 0));
    });
    tl.fromTo(note, { opacity: 0 }, { opacity: 1, duration: 1.2, ease: 'sine.out' }, '+=0.4');
    tl.to(this.history, { opacity: 0, duration: 1.4, ease: 'sine.in' }, '+=6');
    tl.set(this.history, { display: 'none' });
  }

  hideHistory(): void {
    if (!this.historyTl) return;
    this.historyTl.kill();
    this.historyTl = null;
    gsap.to(this.history, { opacity: 0, duration: 0.5, onComplete: () => void (this.history.style.display = 'none') });
  }
}

// ---------------------------------------------------------------- cosmic time

const YEAR = 365.25 * 24 * 3600;

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const group = (n: number) => Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Formats cosmic age in Ukrainian: «0 секунд», «3 хвилини», «380 000 років», «13,8 млрд років». */
export function formatCosmicTime(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) {
    const n = Math.floor(s);
    return `${n} ${plural(n, 'секунда', 'секунди', 'секунд')}`;
  }
  if (s < 3600) {
    const n = Math.floor(s / 60);
    return `${n} ${plural(n, 'хвилина', 'хвилини', 'хвилин')}`;
  }
  if (s < 86400) {
    const n = Math.floor(s / 3600);
    return `${n} ${plural(n, 'година', 'години', 'годин')}`;
  }
  const years = s / YEAR;
  if (years < 1) {
    const n = Math.floor(s / 86400);
    return `${n} ${plural(n, 'доба', 'доби', 'діб')}`;
  }
  if (years < 1e6) {
    const n = years < 1000 ? Math.floor(years) : Math.round(years / 1000) * 1000;
    return `${group(n)} ${plural(n, 'рік', 'роки', 'років')}`;
  }
  if (years < 1e9) return `${Math.round(years / 1e6)} млн років`;
  const g = Math.round(years / 1e8) / 10;
  return `${Number.isInteger(g) ? g : g.toFixed(1).replace('.', ',')} млрд років`;
}

export const cosmicYears = (years: number) => years * YEAR;
