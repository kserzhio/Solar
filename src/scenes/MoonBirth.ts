import * as THREE from 'three';
import { config } from '../config';
import { NOISE, POINT_FRAG, POINT_SIZE, additiveMaterial, gaussian, globalUniforms, mulberry32 } from '../shaders/common';
import type { Ctx } from '../app/types';
import type { CuriousScene } from './curious';
import { createStarfield, disposeObject, lerp, smooth } from './util';

const DURATION = 19;
const IMPACT = 5.2;
const MOON_ORBIT = 3.6;
const MOON_RADIUS = 0.27;
/** Keplerian-ish angular speed: ω ∝ a^-1.5. */
const omega = (a: number) => 1.6 / (a * Math.sqrt(a));

const SUN = new THREE.Vector3(-0.55, 0.3, 0.78).normalize();
const IMPACT_DIR = new THREE.Vector3(-0.88, 0.22, 0.42).normalize();
const THEIA_START = new THREE.Vector3(-12, 1.4, -5);
const THEIA_RADIUS = 0.53;

/** A rocky body lit by the Sun, with molten cracks that glow brighter with `uHeat`. */
function rockyBody(radius: number, dark: string, light: string, seed: number) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalUniforms.uTime,
      uSun: { value: SUN },
      uHeat: { value: 0 },
      uFade: { value: 1 },
      uDark: { value: new THREE.Color(dark) },
      uLight: { value: new THREE.Color(light) },
      uSeed: { value: seed },
      uImpact: { value: IMPACT_DIR.clone() },
      uScar: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vLocal;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vLocal = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform float uTime;
      uniform vec3 uSun;
      uniform float uHeat;
      uniform float uFade;
      uniform vec3 uDark;
      uniform vec3 uLight;
      uniform float uSeed;
      uniform vec3 uImpact;
      uniform float uScar;
      varying vec3 vN;
      varying vec3 vLocal;
      void main() {
        vec3 q = vLocal * 3.0 + vec3(uSeed);
        float crust = fbm3(q) * 0.5 + 0.5;
        float vein = abs(snoise(vLocal * 5.5 + vec3(uSeed * 2.0, uTime * 0.03, 0.0)));
        float cracks = 1.0 - smoothstep(0.0, 0.07, vein);
        float ndl = clamp(dot(normalize(vN), uSun), 0.0, 1.0);
        vec3 rock = mix(uDark, uLight, crust);
        vec3 lava = vec3(1.0, 0.36, 0.07);
        float hot = cracks * (0.25 + uHeat) + uHeat * 0.6 * (1.0 - crust);
        // The wound left by the impact: a glowing basin that slowly crusts over.
        float facing = clamp(dot(vLocal, uImpact), -1.0, 1.0);
        float scar = exp(-(1.0 - facing) * 9.0) * uScar;
        vec3 col = rock * (0.04 + ndl * 1.15) + lava * (hot * 1.3 + scar * 3.0);
        gl_FragColor = vec4(col * uFade, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), material);
}

/**
 * «Народження Місяця»: Theia, a Mars-sized planet, strikes the young Earth a glancing
 * blow. Molten rock sprays out, settles into a ring of debris, and the ring gathers
 * into the Moon.
 */
export class MoonBirth implements CuriousScene {
  readonly name = 'moon' as const;
  readonly group = new THREE.Group();
  active = false;
  onCaption: (text: string, hold: number) => void = () => {};
  onFlash: () => void = () => {};

  private t = 0;
  private told = 0;
  private hit = false;
  private earth = rockyBody(1, '#2a1f1b', '#5a463b', 1.7);
  private theia = rockyBody(THEIA_RADIUS, '#3a2c26', '#8a6a55', 7.3);
  private moon = rockyBody(MOON_RADIUS, '#3b3936', '#8d8a84', 3.9);
  private debris: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private theiaEnd = IMPACT_DIR.clone().multiplyScalar(1 + THEIA_RADIUS * 0.85);
  private moonPos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private spin = new THREE.Quaternion();
  private unregister: () => void;

  constructor(private ctx: Ctx) {
    const count = Math.max(3000, Math.round(26000 * config.particleScale));
    const rand = mulberry32(4510);
    const orb = new Float32Array(count * 4);
    const ej = new Float32Array(count * 4);
    const v = new THREE.Vector3();
    // Ejecta leave the impact site mostly along the surface, in the direction Theia was travelling.
    const along = new THREE.Vector3().subVectors(this.theiaEnd, THEIA_START).normalize();
    for (let i = 0; i < count; i++) {
      const a = 1.35 + Math.pow(rand(), 0.8) * 3.4;
      orb.set([a, rand() * Math.PI * 2, gaussian(rand) * 0.05 * a, rand()], i * 4);
      v.randomDirection().multiplyScalar(0.7).add(IMPACT_DIR).addScaledVector(along, 0.9).normalize();
      ej.set([v.x, v.y, v.z, rand()], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    // Positions are computed in the shader; this attribute only sets the vertex count.
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aOrb', new THREE.BufferAttribute(orb, 4));
    geometry.setAttribute('aEj', new THREE.BufferAttribute(ej, 4));
    const material = additiveMaterial(
      /* glsl */ `
        ${POINT_SIZE}
        uniform float uTau;
        uniform float uFade;
        uniform vec3 uImpact;
        uniform vec3 uMoon;
        attribute vec4 aOrb;
        attribute vec4 aEj;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float tau = max(uTau, 0.0);
          float a = aOrb.x;
          // Spray: fast at first, slowed by gravity.
          float e = 1.0 - exp(-tau * (1.2 + aEj.w));
          vec3 spray = uImpact + aEj.xyz * e * (0.8 + aEj.w * 2.6);
          // Then the cloud settles into a ring and orbits (inner rock faster).
          float th = aOrb.y + 1.6 / (a * sqrt(a)) * tau;
          vec3 ring = vec3(cos(th) * a, aOrb.z, sin(th) * a);
          float c = smoothstep(0.6, 4.8, tau + aEj.w * 0.8);
          vec3 p = mix(spray, ring, c);
          // Finally the ring falls together into the Moon.
          float ta = 6.0 + aOrb.w * 6.2;
          float s = smoothstep(ta - 1.8, ta, tau);
          vec3 lump = uMoon + (ring - uMoon) * 0.035;
          p = mix(p, lump, s * s);
          float cool = smoothstep(0.0, 9.0, tau);
          vec3 hot = vec3(1.0, 0.55, 0.2) * 1.5;
          vec3 rock = vec3(0.75, 0.6, 0.5) * 0.7;
          vColor = mix(hot, rock, cool * 0.75) * (0.7 + aEj.w * 0.6);
          vAlpha = uFade * (0.26 + 0.26 * aEj.w) * (1.0 - smoothstep(0.8, 1.0, s)) * step(0.0001, uTau);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = pointSize(0.045 + aOrb.w * 0.03, -mv.z, vAlpha);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uTau: { value: 0 },
        uFade: { value: 0 },
        uImpact: { value: IMPACT_DIR },
        uMoon: { value: new THREE.Vector3() },
      },
    );
    this.debris = new THREE.Points(geometry, material);
    this.debris.frustumCulled = false;
    this.unregister = ctx.quality.register(geometry, count);

    this.stars = createStarfield(1600, 90, 13) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    this.earth.rotation.z = 0.35;
    this.group.add(this.stars, this.earth, this.theia, this.moon, this.debris);
  }

  get finished(): boolean {
    return this.t >= DURATION;
  }

  enter(): void {
    this.t = 0;
    this.told = 0;
    this.hit = false;
    this.ctx.audio.whoosh(2.6, 0.12);
    this.update(0);
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const fade = smooth(0, 1.2, t) * (1 - smooth(DURATION - 1.2, DURATION, t));
    const tau = t - IMPACT;

    const captions: [number, string, number][] = [
      [0.6, '4,5 мільярда років тому: Тея летить до Землі', 3.4],
      [6.6, 'Удар вириває хмару розпеченого каміння', 3.2],
      [11.4, 'З диска уламків збирається Місяць', 4.4],
    ];
    while (this.told < captions.length && t >= captions[this.told][0]) {
      const [, text, hold] = captions[this.told++];
      this.onCaption(text, hold);
    }

    // Theia closes in, accelerating, and hits at a glancing angle.
    const k = Math.min(1, t / IMPACT);
    this.theia.position.lerpVectors(THEIA_START, this.theiaEnd, k * k);
    this.theia.rotation.y += dt * 0.4;
    this.theia.visible = tau < 0;
    if (!this.hit && tau >= 0) {
      this.hit = true;
      this.onFlash();
      this.ctx.audio.boom();
    }

    const eu = this.earth.material.uniforms;
    eu.uFade.value = fade;
    eu.uHeat.value = tau < 0 ? 0.12 : lerp(1.2, 0.4, smooth(0, 12, tau));
    eu.uScar.value = tau < 0 ? 0 : Math.exp(-tau * 0.25) * smooth(0, 0.15, tau);
    this.earth.rotation.y += dt * 0.12;
    // The impact direction is fixed in space while the planet turns under it.
    (eu.uImpact.value as THREE.Vector3).copy(IMPACT_DIR).applyQuaternion(this.spin.copy(this.earth.quaternion).invert());
    this.theia.material.uniforms.uFade.value = fade;
    this.theia.material.uniforms.uHeat.value = smooth(IMPACT - 1.5, IMPACT, t) * 0.8;

    // The Moon gathers on an orbit a few Earth radii out.
    const th = -1.6 + omega(MOON_ORBIT) * Math.max(0, tau);
    this.moonPos.set(Math.cos(th) * MOON_ORBIT, 0, Math.sin(th) * MOON_ORBIT);
    const grow = smooth(IMPACT + 5, IMPACT + 12.6, t);
    this.moon.position.copy(this.moonPos);
    this.moon.scale.setScalar(Math.max(0.001, Math.cbrt(grow)));
    this.moon.visible = grow > 0.001;
    this.moon.rotation.y += dt * 0.2;
    const mu = this.moon.material.uniforms;
    mu.uFade.value = fade;
    mu.uHeat.value = lerp(1.3, 0.35, smooth(IMPACT + 9, DURATION, t));

    const du = this.debris.material.uniforms;
    du.uTau.value = tau;
    du.uFade.value = fade;
    (du.uMoon.value as THREE.Vector3).copy(this.moonPos);
    this.debris.visible = tau > 0;
    this.stars.material.uniforms.uOpacity.value = 0.75 * fade;

    const cam = this.ctx.camera;
    const az = 0.15 + t * 0.022;
    const rise = smooth(IMPACT + 1, DURATION - 2, t);
    const dist = lerp(8.8, 10.2, rise);
    cam.position.set(Math.sin(az) * dist, lerp(1.2, 4.2, rise), Math.cos(az) * dist);
    if (!this.ctx.reducedMotion && tau > 0) {
      const amp = 0.18 * Math.exp(-tau * 2.5);
      cam.position.x += Math.sin(t * 61.7) * amp;
      cam.position.y += Math.cos(t * 47.3) * amp;
    }
    // Before the impact the view leans towards the incoming planet.
    this.look.copy(this.theia.position).multiplyScalar(tau < 0 ? 0.18 * (1 - k) : 0);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    this.stars.position.copy(cam.position);
  }

  exit(): void {}

  dispose(): void {
    this.unregister();
    disposeObject(this.group);
  }
}
