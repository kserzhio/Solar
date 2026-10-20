import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { gsap } from 'gsap';
import { config } from '../config';
import { GRADES, GradeEffect, type GradeName } from './GradeEffect';
import { LensEffect } from './LensEffect';

/** Bloom + film grain + vignette always; chromatic aberration only around the Big Bang. */
export class Post {
  readonly composer: EffectComposer;
  private bloom: BloomEffect;
  private ca: ChromaticAberrationEffect;
  private caPass: EffectPass;
  /** 0..1, tweened by the timeline. */
  readonly aberration = { value: 0 };
  private grade = new GradeEffect();
  private lens = new LensEffect();
  private lensPass: EffectPass;
  private dof: DepthOfFieldEffect;
  private dofPass: EffectPass;
  /** Flat, tweenable copy of the current grade. */
  private gradeState = Post.flatten('intro');

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloom = new BloomEffect({
      mipmapBlur: true,
      intensity: config.bloom.intensity,
      luminanceThreshold: config.bloom.threshold,
      luminanceSmoothing: config.bloom.smoothing,
      radius: config.bloom.radius,
      levels: 8,
    });
    const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
    noise.blendMode.opacity.value = 0.32;
    const vignette = new VignetteEffect({ offset: 0.28, darkness: 0.62 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });

    this.ca = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0, 0),
      radialModulation: true,
      modulationOffset: 0.1,
    });
    this.caPass = new EffectPass(camera, this.ca);
    this.caPass.enabled = false;

    this.lensPass = new EffectPass(camera, this.lens);
    this.lensPass.enabled = false;
    this.composer.addPass(this.lensPass);
    // Cinematic shallow focus while the camera studies a planet.
    this.dof = new DepthOfFieldEffect(camera, { focusDistance: 10, focusRange: 2, bokehScale: 0, resolutionScale: 0.5 });
    this.dofPass = new EffectPass(camera, this.dof);
    this.dofPass.enabled = false;
    this.composer.addPass(this.dofPass);
    this.composer.addPass(this.caPass);
    this.composer.addPass(new EffectPass(camera, this.bloom, noise, vignette, tone, this.grade));
    this.setGrade('intro', 0);
  }

  private static flatten(name: GradeName): number[] {
    const g = GRADES[name];
    return [...g.lift, ...g.gamma, ...g.gain, g.saturation, g.contrast];
  }

  /** Cross-fades the colour grade to a scene's look. */
  setGrade(name: GradeName, duration = 2): void {
    const target = Post.flatten(name);
    gsap.killTweensOf(this.gradeState);
    const apply = () => {
      const s = this.gradeState;
      const u = this.grade.uniforms;
      (u.get('lift')!.value as THREE.Vector3).set(s[0], s[1], s[2]);
      (u.get('gamma')!.value as THREE.Vector3).set(s[3], s[4], s[5]);
      (u.get('gain')!.value as THREE.Vector3).set(s[6], s[7], s[8]);
      u.get('saturation')!.value = s[9];
      u.get('contrast')!.value = s[10];
    };
    if (duration <= 0) {
      target.forEach((v, i) => (this.gradeState[i] = v));
      apply();
      return;
    }
    gsap.to(this.gradeState, { endArray: target, duration, ease: 'sine.inOut', onUpdate: apply });
  }

  setFocus(f: { distance: number; range: number; amount: number }): void {
    this.dofPass.enabled = f.amount > 0.01;
    if (!this.dofPass.enabled) return;
    this.dof.cocMaterial.focusDistance = f.distance;
    this.dof.cocMaterial.focusRange = f.range;
    this.dof.bokehScale = f.amount * 3.2;
  }

  setLens(l: { center: THREE.Vector2; radius: number; strength: number }): void {
    this.lensPass.enabled = l.strength > 0.002;
    if (!this.lensPass.enabled) return;
    const u = this.lens.uniforms;
    (u.get('center')!.value as THREE.Vector2).copy(l.center);
    u.get('radius')!.value = l.radius;
    u.get('strength')!.value = l.strength;
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.lens.uniforms.get('aspect')!.value = width / Math.max(1, height);
  }

  render(dt: number): void {
    const a = this.aberration.value;
    this.caPass.enabled = a > 0.001;
    if (this.caPass.enabled) this.ca.offset.set(a * 0.012, a * 0.006);
    this.composer.render(dt);
  }

  applyConfig(): void {
    this.bloom.intensity = config.bloom.intensity;
    this.bloom.luminanceMaterial.threshold = config.bloom.threshold;
    this.bloom.luminanceMaterial.smoothing = config.bloom.smoothing;
    this.bloom.mipmapBlurPass.radius = config.bloom.radius;
  }

  /** Cheaper bloom on slow GPUs: fewer mip levels. */
  setBloomLevels(levels: number): void {
    this.bloom.mipmapBlurPass.levels = levels;
  }
}
