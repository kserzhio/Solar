import * as THREE from 'three';
import { gsap } from 'gsap';
import { config } from '../config';
import { MIN_WIDTH } from '../device';
import { AudioEngine } from '../audio/AudioEngine';
import { UI, formatCosmicTime } from '../ui/UI';
import { globalUniforms, updateViewScale } from '../shaders/common';
import { Singularity } from '../scenes/Singularity';
import { BigBang } from '../scenes/BigBang';
import { Plasma } from '../scenes/Plasma';
import { Cosmos } from '../scenes/Cosmos';
import { Approach } from '../scenes/Approach';
import { Solar } from '../scenes/Solar';
import { CosmicZoom } from '../scenes/CosmicZoom';
import { CURIOUS, type CardInfo, type CuriousName, type CuriousScene } from '../scenes/curious';
import type { Gargantua } from '../scenes/Gargantua';
import { Director } from './Director';
import { PerfMonitor } from './PerfMonitor';
import { Post } from './Post';
import { Quality } from './Quality';
import { SceneManager } from './SceneManager';
import type { Ctx } from './types';
import { hideBoot, setBoot } from '../boot';
import { lang, tr } from '../i18n';

type Phase = 'intro' | 'cinematic' | 'final';

/** Quality steps used by the FPS watchdog: particle share, bloom mip levels, max pixel ratio. */
/** An optional scene with things to point at and click (names and info cards). */
interface Explorable {
  onHover: (name: string | null) => void;
  onFocus: (info: CardInfo | null) => void;
}

/** Scenes compiled before the start screen, and those compiled in the background after. */
const FIRST_SCENES = ['bang', 'plasma', 'cosmos'] as const;
const LATER_SCENES = ['approach', 'solar', 'zoom', 'nucleo', 'supernova', 'moon', 'pulsar', 'merger', 'sunfuture', 'trappist', 'gargantua'] as const;
type SceneName = (typeof FIRST_SCENES)[number] | (typeof LATER_SCENES)[number];

const QUALITY_STEPS = [
  { particles: 1, bloomLevels: 8, dpr: 2 },
  { particles: 0.7, bloomLevels: 6, dpr: 1.5 },
  { particles: 0.5, bloomLevels: 5, dpr: 1.25 },
  { particles: 0.35, bloomLevels: 4, dpr: 1 },
];

export class App {
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.PerspectiveCamera(60, 1, 0.02, 100000);
  private scene = new THREE.Scene();
  private stage: HTMLDivElement;
  private ctx: Ctx;
  private ui: UI;
  private post: Post;
  private scenes!: SceneManager;
  private director!: Director;
  private perf: PerfMonitor;
  private timeline: gsap.core.Timeline | null = null;
  private phase: Phase = 'intro';
  private busy = false;
  private pauses = new Set<'user' | 'narrow' | 'hidden'>();
  private time = 0;
  private last = performance.now();
  private maxDpr = 2;
  private particleSignature = '';
  private debug: { toggle(): void } | null = null;
  /** False until every shader is compiled; the start click waits for it. */
  private ready = false;
  /** Seconds since the Solar System became interactive (drives «Ви тут»). */
  private hereT = 99;
  private hereOpacity = 0;
  private compareTmp = new THREE.Vector3();
  private driftCaption: gsap.core.Tween | null = null;
  private lastEclipse: 'solar' | 'lunar' | null = null;
  private showCaptions: gsap.core.Tween[] = [];

  /** Two short lines for each guided close-up (eclipses, the comet). */
  private onShowCaptions(kind: 'solar' | 'lunar' | 'comet' | null): void {
    this.showCaptions.forEach((c) => c.kill());
    this.showCaptions = [];
    if (!kind) return;
    this.cancelHistory();
    const lines: Record<string, [string, string]> = {
      solar: ['Сонячне затемнення: тінь Місяця на Землі', 'Тінь біжить поверхнею майже 2 000 км/год'],
      lunar: ['Місячне затемнення: Місяць у тіні Землі', 'Червоний — це світло всіх світанків Землі'],
      comet: ['Комета: брила льоду й пилу розміром з гору', 'Іонний хвіст завжди дивиться від Сонця'],
    };
    const [a, b] = lines[kind];
    this.ui.showCaption(a, 5);
    this.showCaptions.push(gsap.delayedCall(7.5, () => this.scenes.get<Solar>('solar').showing === kind && this.ui.showCaption(b, 5)));
  }
  /** «13,8 мільярда років в одній лінії», shown once after the first full showing. */
  private historyCall: gsap.core.Tween | null = null;
  /** The optional «Для допитливих» scene that is playing, and what to restore after it. */
  private curious: { name: CuriousName; pos: THREE.Vector3; quat: THREE.Quaternion; up: THREE.Vector3; hidden: THREE.Object3D[] } | null = null;

  constructor(root: HTMLElement) {
    this.stage = document.createElement('div');
    this.stage.className = 'stage';
    root.append(this.stage);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor('#05060a', 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxDpr));
    this.stage.append(this.renderer.domElement);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.ctx = {
      renderer: this.renderer,
      camera: this.camera,
      scene: this.scene,
      canvas: this.renderer.domElement,
      audio: new AudioEngine(),
      quality: new Quality(),
      pointer: { ndc: new THREE.Vector2(), x: 0, y: 0, inside: false },
      reducedMotion,
      orbitClock: { t: 0 },
      hero: {
        position: new THREE.Vector3(10, -2, -42),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.95, 0.25, 0.35)),
        radius: 6,
      },
      lens: { center: new THREE.Vector2(0.5, 0.5), radius: 0.05, strength: 0 },
      dof: { distance: 10, range: 2, amount: 0 },
    };
    this.ctx.audio.setVolume(config.volume);

    this.post = new Post(this.renderer, this.scene, this.camera);
    this.ui = new UI(root, {
      onSound: () => this.toggleSound(),
      onSkip: () => void this.skipToFinal(),
      onRestart: () => void this.restart(),
      onRewind: () => void this.rewind(),
      onSpeed: (v) => (this.scenes.get<Solar>('solar').orbitSpeed = v),
      onCloseCard: () => {
        if (this.curious) this.scenes.get<CuriousScene>(this.curious.name).closeCard?.();
        else this.scenes.get<Solar>('solar').unfocus();
      },
      onSeek: (f) => void this.seekTo(f),
      onZoomLevel: (k) => this.zoomTo(k),
      onZoomHome: () => this.scenes.get<CosmicZoom>('zoom').goHome(),
      onTour: () => this.toggleTour(),
      onCompare: () => void this.toggleCompare(),
      onDrift: () => this.toggleDrift(),
      onCurious: () => this.toggleCurious(),
      onCuriousScene: (name) => void this.openCurious(name),
      onHoleLook: (look) => this.scenes.get<Gargantua>('gargantua').setLook(look),
      onPhoto: () => {
        if (this.phase !== 'intro') this.ui.setPhotoMode(!this.ui.photoMode);
      },
      onSaveFrame: () => this.saveFrame(),
      onShare: () => void this.share(),
      seekLabel: (f) => formatCosmicTime(this.director.cosmicSeconds(f * this.director.endTime)),
    });

    this.perf = new PerfMonitor(QUALITY_STEPS.length - 1, (level) => this.setQuality(level));
    this.buildScenes();
    this.bindEvents();
    this.onResize();
  }

  // ---------------------------------------------------------------- setup

  private buildScenes(): void {
    this.scenes?.disposeAll();
    this.particleSignature = JSON.stringify([config.particles, config.particleScale]);
    this.scenes = new SceneManager(this.ctx);
    const solar = new Solar(this.ctx);
    const zoom = new CosmicZoom(this.ctx, () => solar);
    zoom.onHud = (h) => this.ui.setZoomHud(h);
    zoom.onCaption = (text) => this.ui.showCaption(text, 6);
    [new Singularity(this.ctx), new BigBang(this.ctx), new Plasma(this.ctx), new Cosmos(this.ctx), new Approach(this.ctx), solar, zoom].forEach(
      (s) => this.scenes.add(s),
    );
    this.optional = null;
    solar.onHover = (p) => {
      this.ui.showLabel(p ? p.name : null);
      if (p) this.ctx.audio.uiHover();
    };
    solar.onWormholeHover = (on) => {
      this.ui.showLabel(on ? 'Кротова нора' : null);
      if (on) this.ctx.audio.uiHover();
    };
    // «Інтерстелар»: through the wormhole to Gargantua (or straight back if that cannot start).
    solar.onWormhole = () => {
      void this.loadOptional().then(() => {
        if (this.busy || this.phase !== 'final' || this.curious) {
          solar.returnFromWormhole(1.5);
          return;
        }
        this.scenes.get<Gargantua>('gargantua').entry = solar.portalEntry;
        void this.openCurious('gargantua');
      });
    };
    solar.onTour = (on) => this.ui.setTour(on);
    solar.onDrift = (on) => this.ui.setDrift(on || zoom.motion);
    solar.onShow = (kind) => this.onShowCaptions(kind);
    zoom.onMotion = (on) => this.ui.setDrift(on || solar.drifting);
    solar.onFocus = (p) => {
      if (p) {
        this.ui.showCard(p);
        this.ctx.audio.uiSelect();
      } else {
        this.ctx.audio.uiBack();
        this.ui.hideCard();
        this.ui.showFinalHint(true);
      }
    };
    this.director = new Director(this.ctx, this.scenes, this.ui, this.post, () => this.enterFinal(false));
    this.director.prepare();
    this.ui.setTicks(this.director.ticks());
  }

  /** The optional scenes' chunk, loaded and registered (once per set of scenes). */
  private optional: Promise<void> | null = null;

  private loadOptional(): Promise<void> {
    this.optional ??= import('../scenes/optional').then(({ createOptionalScenes }) => {
      const { menu, gargantua } = createOptionalScenes(this.ctx);
      for (const s of [...menu, gargantua]) {
        s.onCaption = (text, hold) => this.ui.showCaption(text, hold);
        s.onFlash = () => this.ui.flash(this.ctx.reducedMotion);
        this.scenes.add(s);
      }
      // Scenes you can explore: a name on hover, a card on a click.
      for (const s of [...menu, gargantua] as Partial<Explorable>[]) {
        if (!s.onHover || !s.onFocus) continue;
        s.onHover = (name) => {
          this.ui.showLabel(name);
          if (name) this.ctx.audio.uiHover();
        };
        s.onFocus = (info) => {
          if (info) {
            this.ui.showCard(info);
            this.ctx.audio.uiSelect();
          } else {
            this.ui.hideCard();
            this.ctx.audio.uiBack();
          }
        };
      }
      this.wireGargantua(gargantua);
    });
    return this.optional;
  }

  private wireGargantua(gargantua: Gargantua): void {
    const solar = this.scenes.get<Solar>('solar');
    gargantua.onClock = (rows) => this.ui.setClock(rows);
    gargantua.onLook = (look) => {
      this.ui.setHoleLook(look);
      if (look) this.ctx.audio.uiSelect();
    };
    gargantua.exitQuat = () => solar.portalExit;
  }

  start(): void {
    this.scenes.enter('singularity');
    this.renderer.setAnimationLoop(this.frame);
    // Only the film's opening is compiled before the start screen; everything that comes
    // later (the Solar System, the optional scenes, Gargantua) compiles in the background
    // meanwhile, so the site opens sooner.
    void this.precompile(FIRST_SCENES, (f) => setBoot(0.35 + f * 0.65, 'Компілюємо шейдери…')).then(() => {
      this.ready = true;
      hideBoot();
      this.ui.showIntro();
      void this.loadOptional().then(() => this.precompile(LATER_SCENES));
      void this.openDeepLink();
    });
    if (import.meta.env.DEV) {
      // Dev helper for inspecting a frame at a given timeline time: __goTo(seconds).
      Object.assign(window, {
        __app: this,
        // Runs GSAP and the render loop synchronously (for hidden previews where rAF is paused).
        __tick: (seconds: number) => {
          const end = performance.now() + seconds * 1000;
          let prev = 0;
          for (let now = performance.now(); now < end; now = performance.now()) {
            if (now - prev < 16) continue;
            prev = now;
            gsap.ticker.tick();
            this.frame(now);
          }
        },
        // Straight to the Gargantua system, through the wormhole (ticks on its own).
        __toGargantua: async () => {
          const step = async (s: number) => {
            (window as unknown as { __tick: (s: number) => void }).__tick(s);
            await new Promise((r) => setTimeout(r, 0));
          };
          this.pauses.delete('user');
          if (this.phase !== 'final') {
            const p = this.skipToFinal();
            for (let i = 0; i < 20; i++) await step(0.2);
            await p;
            for (let i = 0; i < 6; i++) await step(0.5);
          }
          this.scenes.get<Solar>('solar').enterWormhole();
          const g = this.scenes.get<Gargantua>('gargantua');
          for (let i = 0; i < 200 && !(this.curious && g.finished === false && this.scenes.isActive('gargantua')); i++) await step(0.25);
          for (let i = 0; i < 60 && (g as unknown as { phase: string }).phase === 'in'; i++) await step(0.25);
          for (let i = 0; i < 20; i++) await step(0.25);
          this.pauses.add('user');
        },
        __goTo: (t: number) => {
          if (!this.timeline) this.begin();
          const tl = this.timeline!;
          this.perf.hold(600);
          if (this.ctx.quality.factor !== 1) this.ctx.quality.setFactor(1);
          this.pauses.clear();
          tl.pause();
          let fakeNow = this.last;
          for (let x = tl.time(); x < t; ) {
            x = Math.min(t, x + 1 / 30);
            tl.time(x, false);
            this.frame((fakeNow += 1000 / 30));
          }
          this.pauses.add('user');
          gsap.set([this.ui.flashEl], { opacity: 0 });
          return tl.time();
        },
      });
      // Smoke test of every scene: __selfTest() in the console, or open the page with ?selftest.
      const selfTest = () => import('../debug/selfTest').then(({ runSelfTest }) => runSelfTest(this));
      Object.assign(window, { __selfTest: selfTest });
      if (new URLSearchParams(location.search).has('selftest')) {
        const wait = window.setInterval(() => {
          if (!this.ready) return;
          window.clearInterval(wait);
          void selfTest();
        }, 300);
      }
      void import('../debug/DebugPanel').then(({ createDebugPanel }) => {
        this.debug = createDebugPanel({
          applyConfig: () => this.scenes.applyConfig(),
          applyBloom: () => this.post.applyConfig(),
          setVolume: (v) => this.ctx.audio.setVolume(v),
          stats: () => ({ fps: this.perf.fps, quality: this.ctx.quality.factor, particles: this.countDrawn() }),
        });
      });
    }
  }

  /**
   * A link straight to a scene (?scene=solar, ?scene=gargantua, ?scene=pulsar, …): skip the
   * film to the Solar System and, for a scene of «Для допитливих» or Gargantua, open it.
   */
  private async openDeepLink(): Promise<void> {
    const name = new URLSearchParams(location.search).get('scene');
    if (!name) return;
    const curious = name === 'gargantua' || CURIOUS.some((c) => c.name === name);
    if (name !== 'solar' && !curious) return;
    if (curious) await this.loadOptional();
    await this.skipToFinal();
    if (!curious) return;
    // Let the arrival settle (the veil lifting, the title) before the scene.
    await new Promise((r) => window.setTimeout(r, 700));
    if (name === 'gargantua') this.scenes.get<Gargantua>('gargantua').entry = this.scenes.get<Solar>('solar').portalEntry;
    void this.openCurious(name as CuriousName);
  }

  /** Keeps the scene on screen in the address (?scene=…), so the link can be shared. */
  private setSceneParam(name: string | null): void {
    try {
      const url = new URL(location.href);
      if (name) url.searchParams.set('scene', name);
      else url.searchParams.delete('scene');
      history.replaceState(history.state, '', url);
    } catch {
      // Some embedded views refuse history changes; the link just stays as it was.
    }
  }

  /**
   * A link to what is on screen. In the built site each scene has its own page (s/<scene>,
   * made by vite.config.ts) with that scene's picture and text for link previews, which
   * then opens the scene here; in development the link is just ?scene=….
   */
  private async share(): Promise<void> {
    const scene = this.curious?.name ?? (this.phase === 'final' ? 'solar' : null);
    const root = location.origin + location.pathname.replace(/(en(\.html)?|index\.html)$/, '');
    let url = root + (lang === 'en' ? 'en' : '');
    if (scene && import.meta.env.DEV) url = `${location.origin}${location.pathname}?scene=${scene}`;
    else if (scene) url = `${root}${lang === 'en' ? 'en/' : ''}s/${scene}`;
    const title = tr('Народження Всесвіту');
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      this.ui.showToast(tr('Посилання скопійовано'));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // No clipboard (an insecure page or a refusal): show the link to copy by hand.
      this.ui.showToast(url);
    }
  }

  /** Compile scenes' shaders ahead of time so transitions don't hitch. */
  private async precompile(names: readonly SceneName[] = [...FIRST_SCENES, ...LATER_SCENES], onProgress?: (fraction: number) => void): Promise<void> {
    for (let i = 0; i < names.length; i++) {
      // (The optional scenes are compiled once their chunk has loaded.)
      if (!this.scenes.has(names[i])) continue;
      const group = this.scenes.get(names[i]).group;
      // A scene already on screen (reached before its turn came) has compiled as it showed;
      // moving its group here would take it off the screen.
      if (group.parent) {
        onProgress?.((i + 1) / names.length);
        continue;
      }
      // Hidden objects are skipped by the compiler, so show everything temporarily.
      const hidden: THREE.Object3D[] = [];
      group.traverse((o) => {
        if (!o.visible) {
          hidden.push(o);
          o.visible = true;
        }
      });
      const temp = new THREE.Scene();
      temp.add(group);
      try {
        // Compiled for the buffer the scene is really drawn into (linear light, no tone
        // mapping), not for the screen: otherwise every shader built here is built again,
        // differently, the first time it shows, and on Direct3D that stalls for seconds
        // (it did on the way through the wormhole and back).
        const target = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this.post.composer.inputBuffer);
        const compiled = this.renderer.compileAsync(temp, this.camera);
        this.renderer.setRenderTarget(target);
        await compiled;
      } catch (err) {
        console.warn('Shader precompile failed', err);
      }
      temp.remove(group);
      hidden.forEach((o) => (o.visible = false));
      onProgress?.((i + 1) / names.length);
    }
    this.perf.hold(2);
  }

  private bindEvents(): void {
    const canvas = this.ctx.canvas;
    // If the graphics driver resets, the page loses its WebGL context and would sit black.
    // Say so; when the context comes back, reload (on the same scene: ?scene= is kept in the
    // address), which rebuilds every shader and texture cleanly.
    let stuck = 0;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.renderer.setAnimationLoop(null);
      this.ui.setContextLost(true);
      stuck = window.setTimeout(() => this.ui.setContextLost(true, true), 4000);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      window.clearTimeout(stuck);
      location.reload();
    });
    const p = this.ctx.pointer;
    const setPointer = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      p.x = e.clientX;
      p.y = e.clientY;
      p.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      p.inside = true;
      this.ui.moveLabel(e.clientX, e.clientY);
    };
    canvas.addEventListener('pointermove', setPointer);
    canvas.addEventListener('pointerdown', setPointer);
    canvas.addEventListener('pointerleave', () => (p.inside = false));
    // Registered before the cosmic zoom's own capture listener, so it can keep the wheel
    // away from the paused Solar System while an optional scene plays.
    window.addEventListener('wheel', (e) => this.curious && !this.curiousScene?.interactive && e.stopImmediatePropagation(), { capture: true });
    canvas.addEventListener('click', () => {
      if (this.phase === 'intro' && !this.busy && this.ready) this.begin();
    });

    // Audio may only start after a user gesture.
    const unlock = () => this.ctx.audio.ensure();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      this.setPause('hidden', document.hidden);
      if (!document.hidden) this.perf.hold(2);
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.onCuriousKey(e)) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.setPause('user', !this.pauses.has('user'));
        break;
      case 'KeyM':
        this.toggleSound();
        break;
      case 'KeyS':
        void this.skipToFinal();
        break;
      case 'KeyR':
        void this.restart();
        break;
      case 'KeyB':
        void this.rewind();
        break;
      case 'KeyZ':
        if (this.phase === 'final') this.zoomStep(1);
        break;
      case 'KeyX':
        if (this.phase === 'final') this.zoomStep(-1);
        break;
      case 'KeyH':
        if (this.phase === 'final') this.scenes.get<CosmicZoom>('zoom').goHome();
        break;
      case 'KeyT':
        if (this.phase === 'final') this.toggleTour();
        break;
      case 'KeyG':
        if (this.phase === 'final') this.toggleDrift();
        break;
      case 'KeyE':
        if (this.phase === 'final' && !this.busy) {
          const solar = this.scenes.get<Solar>('solar');
          // Alternates: a solar eclipse first, then a lunar one.
          solar.startEclipse(this.lastEclipse === 'solar' ? 'lunar' : 'solar');
          if (solar.showing) this.lastEclipse = solar.showing as 'solar' | 'lunar';
        }
        break;
      case 'KeyJ':
        if (this.phase === 'final' && !this.busy) this.scenes.get<Solar>('solar').followComet();
        break;
      case 'KeyK':
        if (this.phase === 'final') {
          const solar = this.scenes.get<Solar>('solar');
          solar.setConstellations(!solar.constellations);
        }
        break;
      case 'KeyV':
        if (this.phase === 'final') void this.toggleCompare();
        break;
      case 'KeyP':
        if (this.phase !== 'intro') this.ui.setPhotoMode(!this.ui.photoMode);
        break;
      case 'KeyC':
        if (this.ui.photoMode) this.saveFrame();
        break;
      case 'KeyD':
        this.debug?.toggle();
        break;
      case 'Enter':
        if (this.phase === 'intro' && !this.busy && this.ready) this.begin();
        break;
      case 'Escape':
        if (this.ui.photoMode) this.ui.setPhotoMode(false);
        else if (this.phase === 'final' && this.scenes.get<Solar>('solar').showing) this.scenes.get<Solar>('solar').endShow();
        else if (this.phase === 'final' && this.scenes.get<Solar>('solar').comparing) void this.toggleCompare();
        else if (this.phase === 'final') {
          const solar = this.scenes.get<Solar>('solar');
          solar.stopTour();
          solar.unfocus();
        }
        break;
    }
  }

  /** Keys of «Для допитливих»; returns true when the key was handled (or must be ignored). */
  private onCuriousKey(e: KeyboardEvent): boolean {
    if (this.curious) {
      if (e.code === 'Escape' && this.ui.photoMode) return false;
      if (e.code === 'Escape' || e.code === 'KeyN') {
        if (!this.curiousScene?.requestExit?.()) void this.closeCurious();
        return true;
      }
      if (e.code === 'KeyF' && this.curious.name === 'gargantua') {
        this.scenes.get<Gargantua>('gargantua').toggleLook();
        return true;
      }
      // Only pause, sound, photo mode, restart and the debug panel apply inside a scene.
      return !['Space', 'KeyM', 'KeyP', 'KeyC', 'KeyR', 'KeyD'].includes(e.code);
    }
    if (e.code === 'KeyN' && this.phase === 'final') {
      this.toggleCurious();
      return true;
    }
    if (!this.ui.curiousMenuOpen) return false;
    if (e.code === 'Escape') {
      this.ui.setCuriousMenu(false);
      return true;
    }
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'].indexOf(e.code);
    if (n >= 0 && n < CURIOUS.length) {
      void this.openCurious(CURIOUS[n].name);
      return true;
    }
    return false;
  }

  private toggleCurious(): void {
    if (this.curious) {
      if (!this.curiousScene?.requestExit?.()) void this.closeCurious();
    } else if (this.phase === 'final' && !this.busy) this.ui.setCuriousMenu(!this.ui.curiousMenuOpen);
  }

  /**
   * Plays an optional scene: the Solar System (and the zoom) stay entered but frozen and
   * hidden, the camera pose is kept, and everything is put back exactly afterwards.
   */
  private async openCurious(name: CuriousName): Promise<void> {
    if (!this.scenes.has(name)) await this.loadOptional();
    const solar = this.scenes.get<Solar>('solar');
    if (this.busy || this.phase !== 'final' || this.curious) return;
    const scene = this.scenes.get<CuriousScene>(name);
    this.ui.setCuriousMenu(false);
    this.busy = true;
    this.cancelHistory();
    solar.stopTour();
    this.ctx.audio.uiSelect();
    if (!scene.seamless) await this.ui.veil(1, 0.45);
    if (solar.comparing) {
      solar.setCompare(false);
      this.ui.setCompare(false);
    }
    const cam = this.camera;
    const hidden = this.scene.children.filter((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    this.curious = { name, pos: cam.position.clone(), quat: cam.quaternion.clone(), up: cam.up.clone(), hidden };
    this.scenes.freeze(['solar', 'zoom'], true);
    this.scenes.get<CosmicZoom>('zoom').suspended = true;
    if (!scene.interactive) this.ctx.canvas.style.pointerEvents = 'none';
    this.ui.showLabel(null);
    this.ui.clearCaption();
    this.ui.setCurious(true, !!scene.interactive);
    this.scenes.enter(name);
    this.setSceneParam(name);
    this.post.setGrade(name === 'moon' ? 'approach' : 'cosmos', 0);
    this.perf.hold(1);
    if (!scene.seamless) await this.ui.veil(0, 0.6);
    this.busy = false;
  }

  private get curiousScene(): CuriousScene | null {
    return this.curious ? this.scenes.get<CuriousScene>(this.curious.name) : null;
  }

  private async closeCurious(): Promise<void> {
    if (!this.curious || this.busy) return;
    this.busy = true;
    const quick = !!this.curiousScene?.seamless;
    // Through the wormhole the flight carries on through the dip, so it can be very brief.
    const wormhole = this.curious.name === 'gargantua';
    await this.ui.veil(1, wormhole ? 0.15 : quick ? 0.25 : 0.45);
    this.leaveCurious();
    await this.ui.veil(0, wormhole ? 0.35 : quick ? 0.4 : 0.7);
    this.busy = false;
  }

  /** Puts the Solar System back as it was (also used when restarting from inside a scene). */
  private leaveCurious(): void {
    const c = this.curious;
    if (!c) return;
    this.curious = null;
    this.scenes.exit(c.name);
    this.setSceneParam(null);
    c.hidden.forEach((o) => (o.visible = true));
    this.camera.position.copy(c.pos);
    this.camera.quaternion.copy(c.quat);
    this.camera.up.copy(c.up);
    this.scenes.freeze(['solar', 'zoom'], false);
    this.scenes.get<CosmicZoom>('zoom').suspended = false;
    this.ctx.canvas.style.pointerEvents = '';
    this.ui.clearCaption();
    this.ui.setCurious(false);
    this.post.setGrade('solar', 0);
    this.perf.hold(1);
    if (c.name === 'gargantua') {
      const g = this.scenes.get<Gargantua>('gargantua');
      this.scenes.get<Solar>('solar').returnFromWormhole(g.exitRc, g.exitSpeed);
    }
  }

  /**
   * «Політ крізь Галактику»: the Sun races round the Milky Way and the planets follow it on
   * helices. Two short captions explain what is on screen.
   */
  private toggleDrift(): void {
    const solar = this.scenes.get<Solar>('solar');
    const zoom = this.scenes.get<CosmicZoom>('zoom');
    if (this.busy || solar.comparing) return;
    if (zoom.z > 0.001) {
      // Zoomed out: the same button sets the Galaxy, the Local Group and beyond in motion.
      zoom.setMotion(!zoom.motion);
      return;
    }
    const on = !solar.drifting;
    this.driftCaption?.kill();
    this.cancelHistory();
    solar.setDrift(on);
    if (!on) return;
    this.ui.showCaption('Сонце мчить крізь Галактику: 230 км/с', 5);
    this.driftCaption = gsap.delayedCall(7, () => {
      if (solar.drifting) this.ui.showCaption('А планети летять за ним по спіралях', 5);
    });
  }

  private toggleTour(): void {
    const solar = this.scenes.get<Solar>('solar');
    if (solar.comparing || this.curious) return;
    solar.toggleTour();
  }

  /** True-scale line-up of the Sun and planets, entered and left through a short fade. */
  private async toggleCompare(): Promise<void> {
    const solar = this.scenes.get<Solar>('solar');
    const zoom = this.scenes.get<CosmicZoom>('zoom');
    if (this.busy || this.phase !== 'final' || zoom.z > 0.001 || this.curious) return;
    this.busy = true;
    const on = !solar.comparing;
    this.cancelHistory();
    await this.ui.veil(1, 0.35);
    solar.setCompare(on);
    this.ui.setCompare(on);
    this.perf.hold(1);
    await this.ui.veil(0, 0.6);
    if (on && solar.comparing) this.ui.showCaption('Справжні пропорції: Сонце і вісім планет', 5);
    this.busy = false;
  }

  private skyTmp: { pos: THREE.Vector3; text: string; kind: 'star' | 'constellation' | 'galaxy' }[] = [];

  /** Star and constellation names while the figures are on (K). */
  private updateSkyLabels(solar: Solar | null): void {
    const w = solar && this.phase === 'final' && !this.curious ? solar.figuresWeight : 0;
    if (w < 0.01) {
      if (this.skyLabelsShown) this.ui.setSkyLabels([]);
      this.skyLabelsShown = false;
      return;
    }
    this.skyLabelsShown = true;
    solar!.skyLabels(this.skyTmp);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const out = this.skyTmp.flatMap((l) => {
      const v = this.compareTmp.copy(l.pos).project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.02 || Math.abs(v.y) > 1.02) return [];
      return [{ x: (v.x * 0.5 + 0.5) * W, y: (1 - (v.y * 0.5 + 0.5)) * H, text: l.text, kind: l.kind, opacity: w }];
    });
    this.ui.setSkyLabels(out);
  }

  private skyLabelsShown = false;

  private updateCompareLabels(solar: Solar | null): void {
    if (!solar?.comparing) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const out = solar.compareLabels.map((l) => {
      const v = this.compareTmp.copy(l.pos).project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      return { x: visible ? (v.x * 0.5 + 0.5) * w : -999, y: visible ? (1 - (v.y * 0.5 + 0.5)) * h : -999, text: l.text, sub: l.sub };
    });
    this.ui.setCompareLabels(out);
  }

  private zoomTo(level: number): void {
    if (this.scenes.get<Solar>('solar').comparing) return;
    this.scenes.get<Solar>('solar').stopTour();
    this.scenes.get<CosmicZoom>('zoom').goTo(level);
  }

  private zoomStep(dir: 1 | -1): void {
    if (this.scenes.get<Solar>('solar').comparing) return;
    this.scenes.get<Solar>('solar').stopTour();
    this.scenes.get<CosmicZoom>('zoom').step(dir);
  }

  /** Saves the current frame as a PNG (rendered again so the drawing buffer is fresh). */
  private saveFrame(): void {
    this.post.render(0);
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `narodzhennia-vsesvitu-${Date.now()}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    updateViewScale(this.camera, this.renderer.domElement.height);
    const narrow = w < MIN_WIDTH;
    this.ui.setNarrow(narrow);
    this.setPause('narrow', narrow);
  }

  // ---------------------------------------------------------------- flow

  private begin(): void {
    this.phase = 'cinematic';
    this.ctx.audio.ensure();
    this.ui.hideIntro();
    this.ui.setLetterbox(true);
    this.ui.setTimelineVisible(true);
    this.timeline = this.director.build();
    this.ui.setTicks(this.director.ticks());
    this.timeline.play(0);
    this.perf.hold(2);
    if (this.pauses.size) this.timeline.pause();
  }

  private enterFinal(snapCamera: boolean): void {
    this.phase = 'final';
    this.scenes.exit('approach');
    const solar = this.scenes.get<Solar>('solar');
    solar.orbitSpeed = 1;
    solar.makeInteractive(snapCamera);
    this.scenes.enter('zoom');
    this.hereT = 0;
    this.ui.setFinal(true);
    this.ui.setLetterbox(false);
    this.ui.setTimeline(1, formatCosmicTime(this.director.cosmicSeconds(this.director.endTime)));
    // After the film (not after a skip), once the title has gone: the whole story as one line.
    this.historyCall?.kill();
    this.historyCall = snapCamera
      ? null
      : gsap.delayedCall(12, () => {
          this.historyCall = null;
          const zoom = this.scenes.get<CosmicZoom>('zoom');
          if (this.phase === 'final' && zoom.z < 0.01 && solar.focusedIndex < 0 && !solar.touring && !this.ui.photoMode) {
            this.ui.showHistory();
          }
        });
  }

  private cancelHistory(): void {
    this.historyCall?.kill();
    this.historyCall = null;
    this.ui.hideHistory();
  }

  /**
   * Jump to any moment of the film: rebuild the timeline and fast-forward it (without
   * rendering, flashes or sound cues) so every scene arrives in its exact state.
   */
  private async seekTo(fraction: number): Promise<void> {
    if (this.busy || !this.ready || this.phase === 'intro') return;
    const end = this.director.endTime;
    const target = fraction * end;
    if (target >= end - 0.25) {
      if (this.phase !== 'final') void this.skipToFinal();
      return;
    }
    this.busy = true;
    this.cancelHistory();
    await this.ui.veil(1, 0.3);
    this.leaveCurious();
    this.timeline?.kill();
    this.scenes.exitAll();
    this.post.aberration.value = 0;
    this.ui.clearCaption();
    this.ui.setFinal(false);
    this.ui.setLetterbox(true);
    this.ctx.orbitClock.t = 0;
    this.phase = 'cinematic';
    this.scenes.enter('singularity');

    const tl = this.director.build();
    this.timeline = tl;
    tl.pause();
    this.director.seeking = true;
    this.ctx.audio.cuesEnabled = false;
    const step = 1 / 30;
    for (let t = 0; t < target; ) {
      t = Math.min(target, t + step);
      tl.time(t, false);
      this.time += step;
      globalUniforms.uTime.value = this.time;
      this.scenes.update(step, this.time);
    }
    this.director.seeking = false;
    this.ctx.audio.cuesEnabled = true;
    const stage = this.director.stageAt(target);
    this.ctx.audio.settle(stage);
    this.post.setGrade(stage, 0);
    if (!this.pauses.size) tl.play();
    this.perf.hold(2);
    await this.ui.veil(0, 0.5);
    this.busy = false;
  }

  /**
   * «Назад у часі»: the cosmic clock spins back to zero, the planets wind backwards,
   * light floods in, and the film starts again from the singularity on its own.
   */
  private async rewind(): Promise<void> {
    if (this.busy || this.phase !== 'final' || this.curious) return;
    this.busy = true;
    this.cancelHistory();
    const solar = this.scenes.get<Solar>('solar');
    const reduced = this.ctx.reducedMotion;
    const end = this.director.endTime;
    this.ui.setFinal(false);
    this.ui.clearCaption();
    this.ctx.audio.rewind(2.6);
    gsap.to(solar, { orbitSpeed: -14, duration: 1.6, ease: 'power2.in' });
    gsap.to(this.post.aberration, { value: reduced ? 0.15 : 0.7, duration: 2.4, ease: 'power2.in' });
    const clock = this.ui.rewindClock(2.6, (f) => formatCosmicTime(this.director.cosmicSeconds(f * end)));
    gsap.to(this.ui.flashEl, { opacity: reduced ? 0.35 : 1, duration: 1.1, delay: 1.5, ease: 'power2.in' });
    await clock;

    this.timeline?.kill();
    this.timeline = null;
    this.scenes.exitAll();
    gsap.killTweensOf(this.post.aberration);
    this.post.aberration.value = 0;
    this.post.setGrade('intro', 0);
    this.ui.setLetterbox(false);
    this.ui.setTimelineVisible(false);
    this.ctx.audio.reset();
    this.ctx.orbitClock.t = 0;
    this.phase = 'intro';
    this.scenes.enter('singularity');
    this.perf.hold(2);
    gsap.to(this.ui.flashEl, { opacity: 0, duration: 1.4, ease: 'power2.out' });
    this.busy = false;
    // A breath on the singularity, then the story replays by itself.
    window.setTimeout(() => {
      if (this.phase === 'intro' && !this.busy) this.begin();
    }, 1800);
  }

  private async skipToFinal(): Promise<void> {
    if (this.phase === 'final' || this.busy) return;
    this.busy = true;
    this.ctx.audio.ensure();
    await this.ui.veil(1, 0.45);
    this.timeline?.kill();
    this.timeline = null;
    this.scenes.exitAll();
    this.post.aberration.value = 0;
    this.ui.clearCaption();
    this.ui.hideIntro();
    this.ui.setTimelineVisible(true);
    this.ctx.audio.ambient(2.5);
    this.scenes.enter('solar');
    this.post.setGrade('solar', 0);
    this.enterFinal(true);
    this.perf.hold(2);
    this.ui.showTitle();
    await this.ui.veil(0, 0.9);
    this.busy = false;
  }

  private async restart(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.cancelHistory();
    this.ui.setPhotoMode(false);
    await this.ui.veil(1, 0.45);
    this.leaveCurious();
    this.timeline?.kill();
    this.timeline = null;
    this.scenes.exitAll();
    this.post.aberration.value = 0;
    this.ui.clearCaption();
    this.ui.setFinal(false);
    this.ui.setLetterbox(false);
    this.ui.setTimelineVisible(false);
    this.ui.setTimeline(0, formatCosmicTime(0));
    this.pauses.delete('user');
    this.ui.setPaused(false);
    this.ctx.audio.setPaused(false);
    this.ctx.audio.reset();
    if (JSON.stringify([config.particles, config.particleScale]) !== this.particleSignature) {
      this.buildScenes();
      void this.loadOptional().then(() => this.precompile());
    }
    this.ctx.orbitClock.t = 0;
    this.phase = 'intro';
    this.post.setGrade('intro', 0);
    this.scenes.enter('singularity');
    this.ui.showIntro();
    this.perf.hold(2);
    await this.ui.veil(0, 0.9);
    this.busy = false;
  }

  private setPause(reason: 'user' | 'narrow' | 'hidden', on: boolean): void {
    if (on) this.pauses.add(reason);
    else this.pauses.delete(reason);
    const paused = this.pauses.size > 0;
    if (paused) this.timeline?.pause();
    else if (this.timeline && this.phase === 'cinematic') this.timeline.resume();
    this.ui.setPaused(this.pauses.has('user'));
    this.ctx.audio.setPaused(paused);
  }

  private toggleSound(): void {
    this.ctx.audio.ensure();
    const muted = !this.ctx.audio.muted;
    this.ctx.audio.setMuted(muted);
    this.ui.setSound(muted);
  }

  private setQuality(level: number): void {
    const step = QUALITY_STEPS[level];
    this.ctx.quality.setFactor(step.particles);
    this.post.setBloomLevels(step.bloomLevels);
    this.maxDpr = step.dpr;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxDpr));
    this.onResize();
    console.info(`[quality] знижено до рівня ${level}: частинки ×${step.particles}, bloom ${step.bloomLevels}, DPR ≤ ${step.dpr}`);
  }

  /** Shows «Ви тут» next to Earth for a few seconds after arriving in the Solar System. */
  private updateHere(dt: number, solar: Solar | null): void {
    this.hereT += dt;
    let target = 0;
    let pos: { x: number; y: number } | null = null;
    if (solar && this.phase === 'final') {
      pos = solar.planetScreen(2, window.innerWidth, window.innerHeight);
      const window_ = this.hereT > 3 && this.hereT < 11;
      const zoomed = this.scenes.get<CosmicZoom>('zoom').z > 0.01 || solar.comparing;
      if (pos && window_ && !solar.isExploring && !zoomed && !this.curious) target = 1;
    }
    this.hereOpacity += (target - this.hereOpacity) * Math.min(1, (dt || 1 / 60) * 4);
    if (this.hereOpacity < 0.002) this.hereOpacity = 0;
    this.ui.setHere(pos?.x ?? 0, pos?.y ?? 0, pos ? this.hereOpacity : 0);
  }

  private countDrawn(): number {
    let n = 0;
    this.scene.traverseVisible((o) => {
      if ((o as THREE.Points).isPoints) {
        const g = (o as THREE.Points).geometry;
        n += Math.min(g.drawRange.count, g.attributes.position.count);
      }
    });
    return n;
  }

  // ---------------------------------------------------------------- loop

  private frame = (now: number): void => {
    // Never negative: a timestamp older than the previous frame would run decays backwards.
    const realDt = Math.min(Math.max((now - this.last) / 1000, 0), 0.1);
    this.last = now;
    const paused = this.pauses.size > 0;
    const dt = paused ? 0 : Math.min(realDt, 1 / 20);
    this.time += dt;
    globalUniforms.uTime.value = this.time;

    this.ctx.lens.strength = 0;
    this.ctx.dof.amount = 0;
    this.scenes.update(dt, this.time);
    this.post.setLens(this.ctx.lens);
    this.post.setFocus(this.ctx.dof);

    if (this.timeline && this.phase === 'cinematic') {
      const t = this.timeline.time();
      const end = this.director.endTime;
      this.ui.setTimeline(Math.min(1, t / end), formatCosmicTime(this.director.cosmicSeconds(t)));
    }

    const sing = this.scenes.isActive('singularity') ? this.scenes.get<Singularity>('singularity') : null;
    const solar = this.scenes.isActive('solar') ? this.scenes.get<Solar>('solar') : null;
    const pointer =
      (this.phase === 'intro' && sing?.hovered) ||
      (this.phase === 'final' && !this.curious && solar?.wantsPointer) ||
      (this.phase === 'final' && this.curiousScene?.wantsPointer);
    this.stage.classList.toggle('is-pointer', !!pointer);

    this.updateHere(dt, solar);
    this.updateCompareLabels(solar);
    this.updateSkyLabels(solar);
    if (this.curious && !this.busy && this.scenes.get<CuriousScene>(this.curious.name).finished) void this.closeCurious();
    this.post.render(realDt);
    if (!paused) this.perf.tick(realDt);
  };
}
