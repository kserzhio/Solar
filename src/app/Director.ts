import { gsap } from 'gsap';
import { config } from '../config';
import type { SceneManager } from './SceneManager';
import type { Post } from './Post';
import type { Ctx } from './types';
import type { UI, Tick } from '../ui/UI';
import { cosmicYears, formatCosmicTime } from '../ui/UI';
import type { Singularity } from '../scenes/Singularity';
import type { BigBang } from '../scenes/BigBang';
import type { Plasma } from '../scenes/Plasma';
import type { Cosmos } from '../scenes/Cosmos';
import type { Approach } from '../scenes/Approach';
import { APPROACH_CUT } from '../scenes/Approach';
import type { Solar } from '../scenes/Solar';

export type Stage = 'intro' | 'bang' | 'plasma' | 'cosmos' | 'approach' | 'solar';

interface Keyframe {
  t: number;
  seconds: number;
}

/**
 * Builds the single GSAP master timeline that sequences scenes 1–5, captions,
 * audio cues and the cosmic clock. Scenes only expose parameters; all timing lives here.
 */
export class Director {
  private keyframes: Keyframe[] = [];
  /** Stage boundaries of the last built timeline. */
  private stages: { at: number; name: Stage }[] = [];
  /** True while the app fast-forwards the timeline; one-off effects are skipped. */
  seeking = false;

  constructor(
    private ctx: Ctx,
    private scenes: SceneManager,
    private ui: UI,
    private post: Post,
    private onFinal: () => void,
  ) {}

  build(): gsap.core.Timeline {
    const D = config.durations;
    const { audio, reducedMotion } = this.ctx;
    const ui = this.ui;
    const sing = this.scenes.get<Singularity>('singularity');
    const bang = this.scenes.get<BigBang>('bang');
    const plasma = this.scenes.get<Plasma>('plasma');
    const cosmos = this.scenes.get<Cosmos>('cosmos');
    const approach = this.scenes.get<Approach>('approach');
    const solar = this.scenes.get<Solar>('solar');

    const TB = 1.0; // anticipation: collapse into a point
    const TI = TB + 1.0; // inflation ends, reheating: the hot Big Bang flash
    const TP = Math.max(TI + 2.6, D.bang); // plasma
    const TR = TP + D.plasma * 0.42; // recombination: light breaks free
    const TC = TP + D.plasma; // first stars
    const TA = TC + D.cosmos - 1.5; // approach overlaps the end of the cosmos flight
    const TCUT = TA + D.approach * APPROACH_CUT; // young star and its disk
    const TS = TA + D.approach; // the Solar System
    const TE = TS + D.arrival; // interactive

    this.stages = [
      { at: 0, name: 'intro' },
      { at: TI, name: 'bang' },
      { at: TP - 0.6, name: 'plasma' },
      { at: TC, name: 'cosmos' },
      { at: TA, name: 'approach' },
      { at: TS, name: 'solar' },
    ];

    this.keyframes = [
      { t: 0, seconds: 0 },
      { t: TI, seconds: 0 },
      { t: TP, seconds: 180 },
      { t: TR, seconds: cosmicYears(380_000) },
      { t: TC, seconds: cosmicYears(200e6) },
      { t: TCUT, seconds: cosmicYears(9e9) },
      { t: TE, seconds: cosmicYears(13.8e9) },
    ];

    ui.resetCaptions();
    const tl = gsap.timeline({ paused: true });

    // ---- Scene 1: anticipation → flash → shock wave.
    tl.to(sing.params, { collapse: 1, duration: TB, ease: 'power3.in' }, 0);
    tl.call(() => audio.silence(TB * 0.9), [], 0);
    // Inflation: space balloons exponentially out of the point.
    tl.to(sing.params, { inflate: 1, duration: TI - TB, ease: 'expo.in' }, TB);
    tl.call(() => audio.inflation(TI - TB), [], TB);
    ui.addCaption(tl, 'Інфляція: простір роздувається в 10²⁶ разів', 0.05, TI + 1.35);
    tl.call(
      () => {
        if (!this.seeking) ui.flash(reducedMotion);
        this.post.setGrade('bang', 0.6);
        audio.boom();
        this.scenes.enter('bang');
        this.scenes.exit('singularity');
      },
      [],
      TI,
    );
    tl.fromTo(
      this.post.aberration,
      { value: reducedMotion ? 0.25 : 1 },
      { value: 0, duration: 1.8, ease: 'power2.out', immediateRender: false },
      TI,
    );
    ui.addCaption(tl, 'Великий вибух', TI + 1.55, TP - TI - 1.25);

    // ---- Scene 2: plasma cools, light breaks free, darkness.
    tl.call(() => this.scenes.enter('plasma'), [], TP - 0.6);
    tl.call(() => audio.hum(D.plasma), [], TP - 0.4);
    tl.call(() => this.post.setGrade('plasma', 1.5), [], TP - 0.6);
    tl.to(plasma.params, { intensity: 1, duration: 0.9, ease: 'sine.out' }, TP - 0.6);
    tl.fromTo(plasma.params, { temp: 1 }, { temp: 0, duration: D.plasma + 0.4, ease: 'sine.inOut', immediateRender: false }, TP - 0.6);
    tl.fromTo(bang.params, { temp: 1 }, { temp: 0, duration: D.plasma + 0.4, ease: 'sine.inOut', immediateRender: false }, TP - 0.6);
    // Recombination: the fog dissolves, light streams free, and we are left inside the
    // glowing CMB shell. It turns into today's false-colour map, then redshifts away.
    const cmbEnd = Math.min(TR + 5.2, TC - 1.5);
    tl.to(plasma.params, { clear: 1, duration: 1.1, ease: 'power1.inOut' }, TR - 0.3);
    tl.to(plasma.params, { cmb: 1, duration: 0.6, ease: 'sine.out' }, TR - 0.3);
    tl.fromTo(plasma.params, { rays: 0 }, { rays: 1, duration: 1.7, ease: 'power1.out', immediateRender: false }, TR - 0.1);
    tl.to(plasma.params, { falseColor: 1, duration: 1.4, ease: 'sine.inOut' }, TR + 2.3);
    tl.to(plasma.params, { redshift: 1, duration: cmbEnd + 1.4 - (TR + 3.4), ease: 'sine.inOut' }, TR + 3.4);
    tl.to(plasma.params, { cmb: 0, duration: 1.4, ease: 'sine.in' }, cmbEnd);
    tl.to(bang.params, { fade: 0.3, duration: 0.9 }, TR - 0.2);
    tl.to(bang.params, { fade: 0, duration: TC - TR - 0.9 }, TR + 0.7);
    ui.addCaption(tl, 'Гаряча плазма: світло ще в полоні', TP + 0.4, TR - TP - 0.55);
    ui.addCaption(tl, 'Світло вирвалося на волю', TR, 2.6);
    ui.addCaption(tl, 'Реліктове світло: його видно й сьогодні', TR + 2.7, cmbEnd - TR - 2.3);
    ui.addCaption(tl, 'Темні віки', cmbEnd + 0.5, TC - cmbEnd + 0.25);

    // ---- Scene 3: first stars, cosmic web, galaxies.
    tl.call(
      () => {
        cosmos.duration = D.cosmos;
        audio.whoosh(2.2, 0.14);
        this.post.setGrade('cosmos', 3);
        this.scenes.enter('cosmos');
        this.scenes.exit('plasma');
      },
      [],
      TC - 0.05,
    );
    tl.call(() => this.scenes.exit('bang'), [], TC + 0.3);
    tl.fromTo(cosmos.params, { progress: 0 }, { progress: 1, duration: D.cosmos, ease: 'none', immediateRender: false }, TC);
    ui.addCaption(tl, 'Спалахують перші зорі', TC + 0.85, D.cosmos * 0.3 - 0.45);
    ui.addCaption(tl, 'Матерія збирається в космічну павутину', TC + D.cosmos * 0.34, D.cosmos * 0.28);
    ui.addCaption(tl, 'Народжуються галактики', TC + D.cosmos * 0.64, D.cosmos * 0.26);

    // ---- Scene 4: dive into one spiral galaxy and watch planets form.
    tl.call(() => this.scenes.enter('approach'), [], TA);
    tl.call(() => audio.warm(D.approach), [], TA);
    tl.call(() => audio.whoosh(2.0, 0.12), [], TA + 0.2);
    tl.call(() => audio.whoosh(1.6, 0.16), [], TCUT - 0.4);
    tl.call(() => this.post.setGrade('approach', 3), [], TA);
    tl.fromTo(approach.params, { progress: 0 }, { progress: 1, duration: D.approach, ease: 'none', immediateRender: false }, TA);
    tl.to(cosmos.params, { heroFade: 0, duration: 1.6, ease: 'sine.inOut' }, TA);
    tl.to(cosmos.params, { fade: 0, duration: Math.max(1.5, TCUT - TA - 2.2), ease: 'sine.inOut' }, TA + 1.2);
    tl.call(() => this.scenes.exit('cosmos'), [], TCUT);
    ui.addCaption(tl, 'Одна з мільярдів галактик', TA + 0.6, D.approach * APPROACH_CUT - 1);
    ui.addCaption(tl, 'Молода зоря і диск, з якого народжуються планети', TCUT + 0.5, D.approach * (1 - APPROACH_CUT) - 0.3);

    // ---- Scene 5: the Solar System takes over from the disk.
    tl.call(
      () => {
        this.scenes.enter('solar');
        audio.ambient(4);
        audio.whoosh(2.4, 0.1);
        this.post.setGrade('solar', 3);
      },
      [],
      TS,
    );
    tl.fromTo(solar.params, { intro: 0 }, { intro: 1, duration: D.arrival, ease: 'none', immediateRender: false }, TS);
    tl.fromTo(approach.params, { diskFade: 1 }, { diskFade: 0, duration: D.arrival, ease: 'sine.in', immediateRender: false }, TS);
    ui.addTitle(tl, TS + 0.6, D.arrival + 4.4);
    tl.call(() => this.onFinal(), [], TE);
    // Let the last caption finish fading after the hand-off.
    tl.set({}, {}, TE + 3.6);

    return tl;
  }

  ticks(): Tick[] {
    const end = this.keyframes[this.keyframes.length - 1].t;
    return this.keyframes
      .filter((_, i) => i !== 1) // the anticipation keyframe repeats «0 секунд»
      .map((k) => ({ at: k.t / end, label: formatCosmicTime(k.seconds) }));
  }

  stageAt(t: number): Stage {
    let stage: Stage = 'intro';
    for (const s of this.stages) if (t >= s.at) stage = s.name;
    return stage;
  }

  get endTime(): number {
    return this.keyframes[this.keyframes.length - 1]?.t ?? 1;
  }

  /** Cosmic age for a timeline time: cubic over the first minutes, then logarithmic. */
  cosmicSeconds(t: number): number {
    const k = this.keyframes;
    if (t <= k[1].t) return 0;
    for (let i = 1; i < k.length - 1; i++) {
      const a = k[i];
      const b = k[i + 1];
      if (t > b.t) continue;
      const u = (t - a.t) / (b.t - a.t);
      if (a.seconds === 0) return b.seconds * u * u * u;
      return Math.exp(Math.log(a.seconds) + (Math.log(b.seconds) - Math.log(a.seconds)) * u);
    }
    return k[k.length - 1].seconds;
  }

  /** Builds keyframes without running anything, for the skip path. */
  prepare(): void {
    if (!this.keyframes.length) this.build().kill();
  }
}
