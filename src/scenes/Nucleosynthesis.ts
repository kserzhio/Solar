import * as THREE from 'three';
import { config } from '../config';
import { POINT_FRAG, POINT_SIZE, additiveMaterial, mulberry32 } from '../shaders/common';
import type { Ctx } from '../app/types';
import type { CuriousScene } from './curious';
import { clamp01, disposeObject, lerp, smooth } from './util';

const DURATION = 16.5;
/** Nucleons per group: 2 protons + 2 neutrons become helium, 12 protons stay hydrogen (75% / 25% by mass). */
const GROUP = 16;

/**
 * «Перші 3 хвилини»: a hot soup of protons (warm) and neutrons (cool). As it cools,
 * pairs lock into deuterons and pairs of deuterons into helium nuclei, each with a
 * small flash, until a quarter of the mass is helium and the rest stays hydrogen.
 */
export class Nucleosynthesis implements CuriousScene {
  readonly name = 'nucleo' as const;
  readonly group = new THREE.Group();
  active = false;
  onCaption: (text: string, hold: number) => void = () => {};
  onFlash: () => void = () => {};

  private t = 0;
  private told = 0;
  private nextPing = 0;
  private material: THREE.ShaderMaterial;
  private haze: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private unregister: () => void;

  constructor(private ctx: Ctx) {
    const groups = Math.max(200, Math.round(900 * config.particleScale));
    const count = groups * GROUP;
    const rand = mulberry32(2024);
    const home = new Float32Array(count * 3);
    const off = new Float32Array(count * 3);
    const deut = new Float32Array(count * 3);
    const scat = new Float32Array(count * 3);
    const data = new Float32Array(count * 4);
    const tetra = [new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, -1, -1), new THREE.Vector3(-1, 1, -1), new THREE.Vector3(-1, -1, 1)];
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const c = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const inBall = (r: number, out: THREE.Vector3) => out.randomDirection().multiplyScalar(r * Math.cbrt(rand()));

    for (let g = 0; g < groups; g++) {
      inBall(6, c);
      q.setFromEuler(e.set(rand() * 6.283, rand() * 6.283, rand() * 6.283));
      axis.randomDirection();
      const delay = rand();
      for (let k = 0; k < GROUP; k++) {
        const i = g * GROUP + k;
        const fuses = k < 4;
        const neutron = fuses && k % 2 === 1;
        if (fuses) {
          home.set([c.x, c.y, c.z], i * 3);
          v.copy(tetra[k]).normalize().multiplyScalar(0.05).applyQuaternion(q);
          off.set([v.x, v.y, v.z], i * 3);
          v.copy(axis).multiplyScalar(k < 2 ? 0.2 : -0.2);
          deut.set([v.x, v.y, v.z], i * 3);
          inBall(0.9, v);
          scat.set([v.x, v.y, v.z], i * 3);
        } else {
          inBall(1.3, v).add(c);
          home.set([v.x, v.y, v.z], i * 3);
        }
        data.set([neutron ? 1 : 0, fuses ? 1 : 0, rand(), delay], i * 4);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(home, 3));
    geometry.setAttribute('aOff', new THREE.BufferAttribute(off, 3));
    geometry.setAttribute('aDeut', new THREE.BufferAttribute(deut, 3));
    geometry.setAttribute('aScat', new THREE.BufferAttribute(scat, 3));
    geometry.setAttribute('aData', new THREE.BufferAttribute(data, 4));

    this.material = additiveMaterial(
      /* glsl */ `
        ${POINT_SIZE}
        uniform float uT;
        uniform float uFade;
        uniform float uWander;
        uniform float uStart;
        uniform float uSpread;
        attribute vec3 aOff;
        attribute vec3 aDeut;
        attribute vec3 aScat;
        attribute vec4 aData;
        varying vec3 vColor;
        varying float vAlpha;

        vec3 jitter(float ph, float t) {
          return vec3(sin(t * 1.7 + ph), sin(t * 2.3 + ph * 1.7), sin(t * 1.9 + ph * 2.9))
               + 0.35 * vec3(sin(t * 5.1 + ph * 3.1), sin(t * 4.3 + ph * 0.7), sin(t * 6.1 + ph * 1.3));
        }

        void main() {
          float ph = aData.z * 6.2831853;
          vec3 own = jitter(ph, uT) * uWander;
          vec3 p = position + own;
          float he = 0.0;
          float glow = 0.0;
          if (aData.y > 0.5) {
            // The whole nucleus shares one gentle drift once it has formed.
            float gph = fract(dot(position, vec3(12.9898, 78.233, 37.719))) * 6.2831853;
            vec3 shared = jitter(gph, uT * 0.6) * uWander;
            float t1 = uStart + aData.w * uSpread;
            float t2 = t1 + 1.1 + aData.w * 0.5;
            float s1 = smoothstep(t1 - 0.9, t1, uT);
            float s2 = smoothstep(t2 - 0.8, t2, uT);
            vec3 free = position + aScat + own;
            vec3 pair = position + aDeut + aOff * 1.4 + shared * 0.5;
            vec3 nucleus = position + aOff + shared * 0.25;
            p = mix(mix(free, pair, s1), nucleus, s2);
            float a1 = max(uT - t1, 0.0);
            float a2 = max(uT - t2, 0.0);
            glow = step(t1, uT) * exp(-a1 * 4.0) * 1.2 + step(t2, uT) * exp(-a2 * 2.2) * 3.5;
            he = s2;
          }
          vec3 proton = vec3(1.0, 0.42, 0.3);
          vec3 neutron = vec3(0.55, 0.72, 1.0);
          vec3 helium = vec3(1.0, 0.8, 0.42);
          vec3 base = aData.x > 0.5 ? neutron : proton;
          vColor = mix(base, helium, he) * (0.75 + glow) * (1.0 + he * 0.35);
          vAlpha = uFade * (0.42 + 0.2 * he);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = pointSize(0.07 * (1.0 + he * 0.25), -mv.z, vAlpha);
          gl_Position = projectionMatrix * mv;
        }`,
      POINT_FRAG,
      {
        uT: { value: 0 },
        uFade: { value: 0 },
        uWander: { value: 0.35 },
        uStart: { value: 3.6 },
        uSpread: { value: 4.6 },
      },
    );
    const points = new THREE.Points(geometry, this.material);
    points.frustumCulled = false;
    this.group.add(points);
    this.unregister = ctx.quality.register(geometry, count);

    // The glow of a universe still hotter than a star's core, cooling as the scene goes on.
    this.haze = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 70),
      new THREE.ShaderMaterial({
        uniforms: { uIntensity: { value: 0 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uIntensity;
          varying vec2 vUv;
          void main() {
            float d = clamp(length(vUv - 0.5) * 2.0, 0.0, 1.0);
            float k = (1.0 - d) * (1.0 - d);
            gl_FragColor = vec4(vec3(1.0, 0.45, 0.16) * k * uIntensity, 1.0);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.haze.frustumCulled = false;
    this.haze.renderOrder = -5;
    this.group.add(this.haze);
  }

  get finished(): boolean {
    return this.t >= DURATION;
  }

  enter(): void {
    this.t = 0;
    this.told = 0;
    this.nextPing = 4.2;
    this.ctx.audio.whoosh(2.2, 0.12);
    this.update(0);
  }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const u = this.material.uniforms;
    u.uT.value = t;
    u.uFade.value = smooth(0, 1.2, t) * (1 - smooth(DURATION - 1.2, DURATION, t));
    // Cooling: the thermal jitter calms down as the nuclei lock together.
    u.uWander.value = lerp(0.34, 0.1, smooth(1, 11, t));
    this.haze.material.uniforms.uIntensity.value = lerp(0.16, 0.03, smooth(0.5, 12, t)) * u.uFade.value;

    const captions: [number, string, number][] = [
      [0.5, 'Перші три хвилини після Великого вибуху', 3.2],
      [4.6, 'Протони й нейтрони зливаються в ядра гелію', 3.6],
      [10.2, '75% водню і 25% гелію — так і донині', 4.2],
    ];
    while (this.told < captions.length && t >= captions[this.told][0]) {
      const [, text, hold] = captions[this.told++];
      this.onCaption(text, hold);
    }
    // Soft sparks while the helium nuclei snap together.
    if (t >= this.nextPing && t < 9.6) {
      this.nextPing = t + 0.3 + Math.random() * 0.35;
      this.ctx.audio.ping(Math.random() * 1.4 - 0.7);
    }

    const cam = this.ctx.camera;
    const k = clamp01(t / DURATION);
    const dist = lerp(13.5, 8.5, k * k * (3 - 2 * k));
    const az = 0.4 + t * 0.045;
    cam.position.set(Math.sin(az) * dist, 1.4 - k * 0.8, Math.cos(az) * dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    this.haze.position.set(0, 0, 0).addScaledVector(cam.position, -0.6);
    this.haze.quaternion.copy(cam.quaternion);
  }

  exit(): void {}

  dispose(): void {
    this.unregister();
    disposeObject(this.group);
  }
}
